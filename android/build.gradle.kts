// Top-level build file — プラグインの宣言のみ。実際の適用は各モジュールで行う。
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
