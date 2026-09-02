package com.harasou.gpstracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * 端末再起動後・アプリ更新後に、記録中だった場合は位置記録サービスを自動で再開する。
 * アプリ更新(MY_PACKAGE_REPLACED)ではプロセスと前面サービスが止まるため、
 * ここで拾わないと trackingEnabled のまま記録が止まってしまう。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }

        // DataStore の読み取りは suspend なので goAsync で非同期に処理する。
        val pending = goAsync()
        val appContext = context.applicationContext
        CoroutineScope(Dispatchers.Default).launch {
            try {
                val s = SettingsRepository(appContext).current()
                if (s.trackingEnabled) {
                    Log.i(TAG, "自動復帰($action): 記録を再開します")
                    LocationService.start(appContext)
                }
            } catch (e: Exception) {
                Log.w(TAG, "自動復帰に失敗: ${e.message}")
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val TAG = "BootReceiver"
    }
}
