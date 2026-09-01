package com.harasou.gpstracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Looper
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * 前面サービスとして位置情報を購読し、取得ごとにサーバへ送信する。
 * FusedLocationProvider の interval と minUpdateDistance の両方で間引く。
 */
class LocationService : LifecycleService() {

    private lateinit var fused: FusedLocationProviderClient
    private lateinit var settingsRepo: SettingsRepository
    private lateinit var uploader: Uploader
    private var settings: AppSettings? = null

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val s = settings ?: return
            for (loc in result.locations) {
                // 送信はブロッキングなので IO ディスパッチャで実行する。
                lifecycleScope.launch(Dispatchers.IO) {
                    uploader.upload(s, loc)
                }
            }
        }
    }

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

        // 最新の設定を読んでから位置購読を開始する。
        lifecycleScope.launch {
            val s = settingsRepo.current()
            settings = s
            startLocationUpdates(s)
        }

        // 強制終了されても復帰させる。
        return START_STICKY
    }

    @Suppress("MissingPermission")
    private fun startLocationUpdates(s: AppSettings) {
        val intervalMs = s.intervalSec * 1000L
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
            // 端末側でも最短間隔を守る
            .setMinUpdateIntervalMillis(intervalMs)
            // 前回からこの距離未満の変化は通知しない(滞在中のノイズ抑制)
            .setMinUpdateDistanceMeters(s.minDistanceM.toFloat())
            .setWaitForAccurateLocation(false)
            .build()

        try {
            fused.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
            Log.i(TAG, "位置購読開始 interval=${s.intervalSec}s minDist=${s.minDistanceM}m")
        } catch (e: SecurityException) {
            Log.e(TAG, "位置情報の権限がありません", e)
            stopSelf()
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

    override fun onDestroy() {
        fused.removeLocationUpdates(locationCallback)
        Log.i(TAG, "位置購読停止")
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
