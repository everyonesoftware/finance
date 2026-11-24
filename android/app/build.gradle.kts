plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val financeReleaseVersion = providers.gradleProperty("financeReleaseVersion").orNull
val financeVersionCode = financeReleaseVersion?.let { version ->
    val code = Regex("0\\.1\\.([1-9][0-9]{0,9})").matchEntire(version)
        ?.groupValues?.get(1)?.toIntOrNull()
    require(code != null && code in 1..2_100_000_000) {
        "financeReleaseVersion must be 0.1.N with N in 1..2100000000."
    }
    code
}

val releaseSigningInputs = listOf(
    "RELEASE_KEYSTORE_PATH", "RELEASE_KEYSTORE_PASSWORD", "RELEASE_KEY_ALIAS", "RELEASE_KEY_PASSWORD",
).associateWith { providers.environmentVariable(it).orNull?.takeUnless(String::isEmpty) }
val releaseKeystore = releaseSigningInputs["RELEASE_KEYSTORE_PATH"]?.let { file(it) }
val missingReleaseSigningInputs = releaseSigningInputs.filterValues { it == null }.keys

android {
    namespace = "com.everyonesoftware.finance"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "com.everyonesoftware.finance"
        minSdk = 26
        targetSdk = 36
        versionCode = financeVersionCode ?: 1
        versionName = financeReleaseVersion ?: "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        create("release") {
            storeFile = releaseKeystore
            storePassword = releaseSigningInputs["RELEASE_KEYSTORE_PASSWORD"]
            keyAlias = releaseSigningInputs["RELEASE_KEY_ALIAS"]
            keyPassword = releaseSigningInputs["RELEASE_KEY_PASSWORD"]
        }
    }
    buildTypes {
        release { signingConfig = signingConfigs.getByName("release") }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
// Keep normal debug builds independent of signing, but never assemble an unsigned release.
val validateFinanceRelease = tasks.register("validateFinanceRelease") {
    doLast {
        require(financeVersionCode != null) { "Release builds require -PfinanceReleaseVersion=0.1.N." }
        require(missingReleaseSigningInputs.isEmpty()) {
            "Missing release signing inputs: ${missingReleaseSigningInputs.joinToString()}."
        }
        require(releaseKeystore?.isFile == true && releaseKeystore.canRead()) {
            "RELEASE_KEYSTORE_PATH must point to a readable keystore."
        }
    }
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(validateFinanceRelease) }

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    val compose = platform("androidx.compose:compose-bom:2025.11.01")
    implementation(compose)
    androidTestImplementation(compose)
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.compose.material3:material3")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}