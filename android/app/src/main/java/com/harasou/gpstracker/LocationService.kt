package com.harasou.gpstracker

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 前面サービスとして、一定間隔ごとに「必ず 1 件」記録を送る。
 *
 * - タイマーで能動的に現在地を要求する(測位イベント待ちの受動型ではない)。
 * - 位置が取れたら座標付きで送信。取れなければ「位置不明」レコードを送る。
 * - 送信できない(圏外等)ときは Uploader がバッファし、次回成功時に再送する。
 */
class LocationService : LifecycleService() {

    private lateinit var fused: FusedLocationProviderClient
    private lateinit var settingsRepo: SettingsRepository
    private lateinit var uploader: Uploader

    // 記録ループは常に 1 つだけ。onStartCommand が複数回呼ばれても二重起動させない。
    private var loopJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
        settingsRepo = SettingsRepository(this)
        uploader = Uploader(this)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundCompat()
        // 既存ループがあればキャンセルし、必ず 1 つだけ起動する。
        // (再スタート時に最新の設定を読み直す意味も兼ねる)
        loopJob?.cancel()
        loopJob = lifecycleScope.launch { recordLoop() }
        return START_STICKY
    }

    /** 間隔ごとに 1 件送るループ。delay はキャンセル時に例外で抜ける。 */
    private suspend fun recordLoop() {
        val s = settingsRepo.current()
        val intervalMs = (s.intervalSec.coerceAtLeast(1)) * 1000L
        // 測位待ちの上限。間隔より短くして、間隔内に必ず何か送れるようにする。
        val fixTimeoutMs = minOf(intervalMs, 30_000L)
        Log.i(TAG, "記録ループ開始 interval=${s.intervalSec}s fixTimeout=${fixTimeoutMs}ms")

        while (true) {
            tick(s, fixTimeoutMs)
            delay(intervalMs)
        }
    }

    /** 1 回分: 現在地を要求し、取れたら座標付き・取れなければ位置不明として送る。 */
    private suspend fun tick(s: AppSettings, fixTimeoutMs: Long) {
        val loc: Location? = requestLocation(fixTimeoutMs)
        withContext(Dispatchers.IO) {
            if (loc != null) {
                uploader.upload(s, loc)
            } else {
                uploader.uploadNoFix(s, System.currentTimeMillis())
            }
        }
    }

    /** 現在地を 1 回要求する。タイムアウト/失敗/測位不能なら null。 */
    private suspend fun requestLocation(fixTimeoutMs: Long): Location? {
        val cts = CancellationTokenSource()
        return try {
            withTimeoutOrNull(fixTimeoutMs) {
                fused.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.token).await()
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "位置情報の権限がありません", e)
            stopSelf()
            null
        } catch (e: Exception) {
            Log.w(TAG, "測位に失敗: ${e.message}")
            null
        } finally {
            cts.cancel()
        }
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("GPS Tracker")
            .setContentText("位置情報を記録中")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .build()
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "位置記録",
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = "位置情報を記録中の常駐通知" }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /**
     * 最近のアプリ一覧からスワイプで消されたときに呼ばれる。
     * 記録を続けたいので、少し後に自身を再起動するようアラームを仕込む。
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val restart = Intent(applicationContext, LocationService::class.java)
        val pi = PendingIntent.getForegroundService(
            this,
            1,
            restart,
            PendingIntent.FLAG_IMMUTABLE,
        )
        val am = getSystemService(AlarmManager::class.java)
        am.set(AlarmManager.RTC, System.currentTimeMillis() + 1_000, pi)
        Log.i(TAG, "タスク削除を検知。1秒後に再起動を予約")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        Log.i(TAG, "記録ループ停止")
        super.onDestroy()
    }

    companion object {
        private const val TAG = "LocationService"
        private const val CHANNEL_ID = "location_tracking"
        private const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.harasou.gpstracker.STOP"

        fun start(context: Context) {
            val intent = Intent(context, LocationService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, LocationService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }
}
