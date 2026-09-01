package com.harasou.gpstracker

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private lateinit var settingsRepo: SettingsRepository

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settingsRepo = SettingsRepository(this)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    TrackerScreen(settingsRepo)
                }
            }
        }
    }
}

@Composable
private fun TrackerScreen(settingsRepo: SettingsRepository) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()

    var serverUrl by remember { mutableStateOf("") }
    var deviceToken by remember { mutableStateOf("") }
    var intervalSec by remember { mutableStateOf("60") }
    var deviceId by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("") }
    var running by remember { mutableStateOf(false) }

    // 初期値を DataStore から読み込む
    LaunchedEffect(Unit) {
        val s = settingsRepo.settingsFlow.first()
        serverUrl = s.serverUrl
        deviceToken = s.deviceToken
        intervalSec = s.intervalSec.toString()
        deviceId = s.deviceId
        // 記録中に再度開いたときは「停止」ボタンを出す。
        running = s.trackingEnabled
    }

    // まとめて権限をリクエストするランチャ
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val fineGranted = result[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            result[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        status = if (fineGranted) {
            "位置情報の許可を取得しました。バックグラウンドでも記録するには、設定で「常に許可」にしてください。"
        } else {
            "位置情報の許可が必要です。"
        }
    }

    fun requestPermissions() {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        permissionLauncher.launch(perms.toTypedArray())
    }

    fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("GPS Tracker", style = MaterialTheme.typography.headlineSmall)

        OutlinedTextField(
            value = serverUrl,
            onValueChange = { serverUrl = it },
            label = { Text("サーバ URL (例: https://xxx/api/locations)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = deviceToken,
            onValueChange = { deviceToken = it },
            label = { Text("デバイストークン (DEVICE_TOKEN)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = intervalSec,
            onValueChange = { intervalSec = it.filter { c -> c.isDigit() } },
            label = { Text("記録間隔(秒) — この間隔ごとに必ず送信") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )

        if (deviceId.isNotBlank()) {
            Text("端末ID: $deviceId", style = MaterialTheme.typography.bodySmall)
        }

        OutlinedButton(
            onClick = {
                scope.launch {
                    settingsRepo.save(
                        serverUrl = serverUrl,
                        deviceToken = deviceToken,
                        intervalSec = intervalSec.toLongOrNull() ?: 60L,
                    )
                    deviceId = settingsRepo.settingsFlow.first().deviceId
                    status = "設定を保存しました。"
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("設定を保存") }

        OutlinedButton(
            onClick = { requestPermissions() },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("位置情報の権限をリクエスト") }

        if (!running) {
            Button(
                onClick = {
                    when {
                        !hasLocationPermission() -> {
                            status = "先に位置情報の権限を許可してください。"
                            requestPermissions()
                        }
                        serverUrl.isBlank() || deviceToken.isBlank() -> {
                            status = "サーバ URL とデバイストークンを入力・保存してください。"
                        }
                        else -> {
                            scope.launch {
                                settingsRepo.save(
                                    serverUrl = serverUrl,
                                    deviceToken = deviceToken,
                                    intervalSec = intervalSec.toLongOrNull() ?: 60L,
                                )
                                // 再起動後も自動復帰できるよう記録中フラグを立てる。
                                settingsRepo.setTrackingEnabled(true)
                                LocationService.start(context)
                                running = true
                                status = "記録を開始しました。"
                            }
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("記録を開始") }
        } else {
            Button(
                onClick = {
                    scope.launch { settingsRepo.setTrackingEnabled(false) }
                    LocationService.stop(context)
                    running = false
                    status = "記録を停止しました。"
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("記録を停止") }
        }

        if (status.isNotBlank()) {
            Text(status, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
