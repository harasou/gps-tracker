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
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 前面サービスとして、一定間隔ごとに「必ず 1 件」記録を送る。
 *
 * - タイマーで能動的に現在地を要求する(測位イベント待ちの受動型ではない)。
 * - 位置が取れたら座標付きで送信。取れなければ「位置不明」レコードを送る。
 * - 送信できない(圏外等)ときは Uploader がバッファし、次回成功時に再送する。
 * - 次回の起床は coroutine の delay ではなく exact アラームで予約する。
 *   delay (Handler ベース) は Deep Sleep 中に CPU が起きるまで発火しないため、
 *   就寝中など画面 OFF が続く状況で送信間隔が大きく空く原因になっていた。
 */
class LocationService : LifecycleService() {

    private lateinit var fused: FusedLocationProviderClient
    private lateinit var settingsRepo: SettingsRepository
    private lateinit var uploader: Uploader

    // 1 回分の tick は常に 1 つだけ。onStartCommand が複数回呼ばれても二重起動させない。
    private var tickJob: Job? = null

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
            cancelWakeAlarm()
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundCompat()
        // 前回分がまだ走っていればキャンセルし、必ず 1 つだけ実行する。
        // (再スタート時に最新の設定を読み直す意味も兼ねる)
        tickJob?.cancel()
        tickJob = lifecycleScope.launch { tickAndScheduleNext() }
        return START_STICKY
    }

    /** 1 件送信し、完了後に次回分の起床アラームを予約する。 */
    private suspend fun tickAndScheduleNext() {
        val s = settingsRepo.current()
        val intervalMs = (s.intervalSec.coerceAtLeast(1)) * 1000L
        // 測位待ちの上限。間隔より短くして、間隔内に必ず何か送れるようにする。
        val fixTimeoutMs = minOf(intervalMs, 30_000L)
        Log.i(TAG, "tick 開始 interval=${s.intervalSec}s fixTimeout=${fixTimeoutMs}ms")

        tick(s, fixTimeoutMs)
        scheduleWakeAlarm(System.currentTimeMillis() + intervalMs)
    }

    /**
     * Deep Sleep 中でも指定時刻に起きられる exact アラームを予約する。
     * 同じ PendingIntent で予約し直すと OS 側で前回分は自動的に置き換わるため、
     * 二重に発火する心配はない。
     *
     * SCHEDULE_EXACT_ALARM が許可されていない端末(Android 12+ で未許可のケース)では
     * exact アラームを使えないため、非 exact だが Doze の起床は許される
     * setAndAllowWhileIdle にフォールバックする。
     */
    private fun scheduleWakeAlarm(triggerAtMillis: Long) {
        val am = getSystemService(AlarmManager::class.java)
        val pi = wakePendingIntent()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pi)
        } else {
            Log.w(TAG, "SCHEDULE_EXACT_ALARM が未許可のため非exactアラームで代用")
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pi)
        }
    }

    private fun cancelWakeAlarm() {
        getSystemService(AlarmManager::class.java).cancel(wakePendingIntent())
    }

    private fun wakePendingIntent(): PendingIntent = PendingIntent.getForegroundService(
        this,
        REQUEST_CODE_WAKE,
        Intent(applicationContext, LocationService::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** 1 回分: 現在地を要求し、取れたら座標付き・取れなければ位置不明として送る。 */
    private suspend fun tick(s: AppSettings, fixTimeoutMs: Long) {
        val loc: Location? = bestFix(fixTimeoutMs)
        withContext(Dispatchers.IO) {
            if (loc != null) {
                uploader.upload(s, loc)
            } else {
                uploader.uploadNoFix(s, System.currentTimeMillis())
            }
        }
    }

    /**
     * ベストオブN 測位。GPS を最大 windowMs だけ回し、最も精度の良い fix を返す。
     * 単発取得だと 1 発目の粗い fix をそのまま記録してしまうため、短時間サンプリング
     * して精度が収束した点を採る。
     *
     * - 目標精度 [TARGET_ACCURACY_M] 以下の fix が出たら即終了(早期打ち切りで電池節約)。
     * - elapsedRealtime が [STALE_MS] 以上前の古いキャッシュ fix は無視する
     *   (「飛んで戻る」テレポートの一因)。
     * - タイムアウトしても、その間のベスト fix を返す。1 件も取れなければ null。
     */
    private suspend fun bestFix(windowMs: Long): Location? {
        val best = AtomicReference<Location?>(null)
        val request = LocationRequest.Builder(
            Priority.PRIORITY_HIGH_ACCURACY,
            SAMPLE_INTERVAL_MS,
        ).setMinUpdateIntervalMillis(SAMPLE_INTERVAL_MS).build()

        val early: Location? = try {
            withTimeoutOrNull(windowMs) {
                suspendCancellableCoroutine { cont ->
                    val callback = object : LocationCallback() {
                        override fun onLocationResult(result: LocationResult) {
                            val loc = result.lastLocation ?: return
                            val ageMs =
                                (SystemClock.elapsedRealtimeNanos() - loc.elapsedRealtimeNanos) / 1_000_000
                            // 古いキャッシュ fix・精度不明は捨てる。
                            if (ageMs > STALE_MS || !loc.hasAccuracy()) return
                            val cur = best.get()
                            if (cur == null || loc.accuracy < cur.accuracy) best.set(loc)
                            // 目標精度に達したら早期終了。
                            if (loc.accuracy <= TARGET_ACCURACY_M && cont.isActive) {
                                fused.removeLocationUpdates(this)
                                cont.resume(best.get())
                            }
                        }
                    }
                    fused.requestLocationUpdates(request, callback, Looper.getMainLooper())
                    cont.invokeOnCancellation { fused.removeLocationUpdates(callback) }
                }
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "位置情報の権限がありません", e)
            stopSelf()
            return null
        } catch (e: Exception) {
            Log.w(TAG, "測位に失敗: ${e.message}")
            null
        }

        // 早期終了なら early、タイムアウトなら期間中のベスト fix を返す。
        return early ?: best.get()
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
     * 記録を続けたいので、少し後に自身を再起動するよう exact アラームを仕込む。
     * (次回 tick 用に予約済みのアラームと同じ PendingIntent なので、これで置き換わる)
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        scheduleWakeAlarm(System.currentTimeMillis() + 1_000)
        Log.i(TAG, "タスク削除を検知。1秒後に再起動を予約")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        Log.i(TAG, "サービス停止")
        super.onDestroy()
    }

    companion object {
        private const val TAG = "LocationService"
        private const val CHANNEL_ID = "location_tracking"
        private const val NOTIFICATION_ID = 1
        private const val REQUEST_CODE_WAKE = 1
        const val ACTION_STOP = "com.harasou.gpstracker.STOP"

        // ベストオブN 測位のチューニング値(将来 Settings に出せるよう定数化)。
        private const val TARGET_ACCURACY_M = 30f    // これ以下の精度が出たら即採用(早期打ち切り)
        private const val SAMPLE_INTERVAL_MS = 1_000L // GPS サンプリング間隔
        private const val STALE_MS = 10_000L          // これより古いキャッシュ fix は無視

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
