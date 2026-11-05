package com.harasou.gpstracker

import android.content.Context
import android.provider.Settings as AndroidSettings
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

// アプリ全体で 1 つの DataStore を共有する。
val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/** 設定値のスナップショット。 */
data class AppSettings(
    val serverUrl: String,
    val deviceToken: String,
    /** 実際に送信に使う端末ID(上書き指定があればそれ、無ければ既定値)。 */
    val deviceId: String,
    /** 設定画面の入力欄に出す上書き値(空なら既定値を使っている)。 */
    val deviceIdOverride: String,
    /** 記録間隔(秒)。この間隔ごとに必ず 1 件送信する。 */
    val intervalSec: Long,
    /** 記録中か。端末再起動後の自動復帰の判定に使う。 */
    val trackingEnabled: Boolean,
)

class SettingsRepository(private val context: Context) {

    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val DEVICE_TOKEN = stringPreferencesKey("device_token")
        val DEVICE_ID_OVERRIDE = stringPreferencesKey("device_id_override")
        val INTERVAL_SEC = longPreferencesKey("interval_sec")
        val TRACKING_ENABLED = booleanPreferencesKey("tracking_enabled")
    }

    /**
     * 端末ID の既定値。ANDROID_ID は同じ署名のアプリである限り、
     * 「データを削除」やアンインストール→再インストールをしても変わらない
     * (工場出荷リセットでのみ変わる)。乱数UUIDをDataStoreに保存する旧方式だと
     * データ削除のたびに新しい端末ID扱いになり、過去の軌跡と分断されてしまうため、
     * アプリのデータとは独立した ANDROID_ID から導出する。
     */
    private val defaultDeviceId: String by lazy {
        val androidId = AndroidSettings.Secure.getString(
            context.contentResolver,
            AndroidSettings.Secure.ANDROID_ID,
        )
        "android-" + (androidId.orEmpty().ifBlank { "unknown" }).take(16)
    }

    val settingsFlow: Flow<AppSettings> = context.dataStore.data.map { p ->
        val override = (p[Keys.DEVICE_ID_OVERRIDE] ?: "").trim()
        AppSettings(
            serverUrl = p[Keys.SERVER_URL] ?: "",
            deviceToken = p[Keys.DEVICE_TOKEN] ?: "",
            deviceId = override.ifBlank { defaultDeviceId },
            deviceIdOverride = override,
            intervalSec = p[Keys.INTERVAL_SEC] ?: 60L,
            trackingEnabled = p[Keys.TRACKING_ENABLED] ?: false,
        )
    }

    /** サービスなど suspend 文脈から 1 回だけ読むためのヘルパ。 */
    suspend fun current(): AppSettings = settingsFlow.first()

    /** 記録中フラグを更新する(再起動後の自動復帰判定に使う)。 */
    suspend fun setTrackingEnabled(enabled: Boolean) {
        context.dataStore.edit { it[Keys.TRACKING_ENABLED] = enabled }
    }

    suspend fun save(
        serverUrl: String,
        deviceToken: String,
        intervalSec: Long,
        deviceIdOverride: String,
    ) {
        context.dataStore.edit { p ->
            p[Keys.SERVER_URL] = serverUrl.trim()
            p[Keys.DEVICE_TOKEN] = deviceToken.trim()
            p[Keys.INTERVAL_SEC] = intervalSec
            p[Keys.DEVICE_ID_OVERRIDE] = deviceIdOverride.trim()
        }
    }
}
