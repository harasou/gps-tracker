package com.harasou.gpstracker

import android.content.Context
import android.location.Location
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * 位置情報をサーバへ送る。ネットワーク不通時はローカルファイルにバッファし、
 * 次回送信成功時にまとめて送り直す(オフライン対応)。
 *
 * すべてのメソッドはブロッキング(同期)。呼び出し側でワーカースレッドから使うこと。
 */
class Uploader(context: Context) {

    private val appContext = context.applicationContext
    private val bufferFile = File(appContext.filesDir, "buffer.jsonl")

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val iso8601 = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    /** 取得できた位置を送信用 JSON に変換する。 */
    private fun toJson(loc: Location): JSONObject = JSONObject().apply {
        put("latitude", loc.latitude)
        put("longitude", loc.longitude)
        put("recordedAt", iso8601.format(Date(loc.time)))
        put("locationAvailable", true)
        if (loc.hasAccuracy()) put("accuracy", loc.accuracy.toDouble())
        if (loc.hasAltitude()) put("altitude", loc.altitude)
        if (loc.hasSpeed()) put("speed", loc.speed.toDouble())
        if (loc.hasBearing()) put("bearing", loc.bearing.toDouble())
    }

    /** 測位できなかった記録(座標なし)を送信用 JSON に変換する。 */
    private fun noFixJson(timeMillis: Long): JSONObject = JSONObject().apply {
        put("recordedAt", iso8601.format(Date(timeMillis)))
        put("locationAvailable", false)
    }

    /** 取得できた位置を送信する。 */
    fun upload(settings: AppSettings, loc: Location) = send(settings, toJson(loc))

    /** 測位できなかった旨を送信する。 */
    fun uploadNoFix(settings: AppSettings, timeMillis: Long) =
        send(settings, noFixJson(timeMillis))

    /**
     * 1 レコードを送信する。まずバッファ済みを送り、続けて今回分を送る。
     * 失敗したレコードはバッファに退避する。
     */
    private fun send(settings: AppSettings, point: JSONObject) {
        // まず溜まっている分を吐き出す。成功したら今回分も送る。
        val flushed = flushBuffer(settings)
        if (!flushed) {
            // まだ送れないので今回分もバッファに積む。
            appendToBuffer(point)
            return
        }

        val ok = postBatch(settings, listOf(point))
        if (!ok) appendToBuffer(point)
    }

    /**
     * バッファ内の点をまとめて送る。空なら true。送信できたら true、失敗なら false。
     */
    private fun flushBuffer(settings: AppSettings): Boolean {
        if (!bufferFile.exists() || bufferFile.length() == 0L) return true

        val lines = bufferFile.readLines().filter { it.isNotBlank() }
        if (lines.isEmpty()) {
            bufferFile.delete()
            return true
        }

        val points = lines.mapNotNull {
            runCatching { JSONObject(it) }.getOrNull()
        }
        val ok = postBatch(settings, points)
        if (ok) bufferFile.delete()
        return ok
    }

    private fun appendToBuffer(point: JSONObject) {
        runCatching {
            bufferFile.appendText(point.toString() + "\n")
        }.onFailure { Log.w(TAG, "failed to buffer point", it) }
    }

    /**
     * points を {"points":[...]} 形式で POST する。2xx なら成功。
     */
    private fun postBatch(settings: AppSettings, points: List<JSONObject>): Boolean {
        if (settings.serverUrl.isBlank() || settings.deviceToken.isBlank()) {
            Log.w(TAG, "serverUrl または deviceToken が未設定のため送信をスキップ")
            return false
        }
        if (points.isEmpty()) return true

        val body = JSONObject().apply {
            put("deviceId", settings.deviceId)
            put("points", JSONArray(points))
        }.toString().toRequestBody(JSON)

        val request = Request.Builder()
            .url(settings.serverUrl)
            .addHeader("Authorization", "Bearer ${settings.deviceToken}")
            .addHeader("X-Device-Id", settings.deviceId)
            .post(body)
            .build()

        return try {
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) {
                    Log.w(TAG, "送信失敗 code=${resp.code}")
                }
                resp.isSuccessful
            }
        } catch (e: Exception) {
            Log.w(TAG, "送信エラー: ${e.message}")
            false
        }
    }

    companion object {
        private const val TAG = "Uploader"
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
