package com.harasou.gpstracker

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.util.UUID

// アプリ全体で 1 つの DataStore を共有する。
val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/** 設定値のスナップショット。 */
data class AppSettings(
    val serverUrl: String,
    val deviceToken: String,
    val deviceId: String,
    /** 記録間隔(秒) */
    val intervalSec: Long,
    /** 最小移動距離(m)。前回からこの距離未満しか動いていなければ記録しない。 */
    val minDistanceM: Double,
)

class SettingsRepository(private val context: Context) {

    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val DEVICE_TOKEN = stringPreferencesKey("device_token")
        val DEVICE_ID = stringPreferencesKey("device_id")
        val INTERVAL_SEC = longPreferencesKey("interval_sec")
        val MIN_DISTANCE_M = doublePreferencesKey("min_distance_m")
    }

    val settingsFlow: Flow<AppSettings> = context.dataStore.data.map { p ->
        AppSettings(
            serverUrl = p[Keys.SERVER_URL] ?: "",
            deviceToken = p[Keys.DEVICE_TOKEN] ?: "",
            deviceId = p[Keys.DEVICE_ID] ?: "",
            intervalSec = p[Keys.INTERVAL_SEC] ?: 60L,
            minDistanceM = p[Keys.MIN_DISTANCE_M] ?: 15.0,
        )
    }

    /** サービスなど suspend 文脈から 1 回だけ読むためのヘルパ。 */
    suspend fun current(): AppSettings = settingsFlow.first()

    suspend fun save(
        serverUrl: String,
        deviceToken: String,
        intervalSec: Long,
        minDistanceM: Double,
    ) {
        context.dataStore.edit { p ->
            p[Keys.SERVER_URL] = serverUrl.trim()
            p[Keys.DEVICE_TOKEN] = deviceToken.trim()
            p[Keys.INTERVAL_SEC] = intervalSec
            p[Keys.MIN_DISTANCE_M] = minDistanceM
            // 端末 ID は初回に一度だけ自動採番する。
            if (p[Keys.DEVICE_ID].isNullOrBlank()) {
                p[Keys.DEVICE_ID] = "android-" + UUID.randomUUID().toString().take(8)
            }
        }
    }
}
