plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "cn.chmsj.photo"
    compileSdk = 35
    defaultConfig {
        applicationId = "cn.chmsj.photo"
        minSdk = 29
        targetSdk = 35
        versionCode = providers.gradleProperty("photoVersionCode").getOrElse("2").toInt().also { require(it>=2) }
        versionName = providers.gradleProperty("photoVersionName").getOrElse("2.0.0-internal").also { require(Regex("[0-9]+\\.[0-9]+\\.[0-9]+-internal").matches(it)) }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "API_ORIGIN", "\"https://chmsj.cn\"")
        // ZSL is opt-in for controlled device A/B validation, never assumed fast from a capability flag alone.
        buildConfigField("boolean", "ENABLE_ZSL", providers.gradleProperty("photoEnableZsl").getOrElse("false").also { require(it in listOf("true","false")) })
    }
    buildFeatures { buildConfig = true }
    signingConfigs.getByName("debug") {
        // Never silently generate a different key for an already distributed app.
        storeFile = file("../signing/existing-internal-debug.keystore")
        storePassword = "android"
        keyAlias = "androiddebugkey"
        keyPassword = "android"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isIncludeAndroidResources = !project.hasProperty("protocolOnly") }
    if (!project.hasProperty("protocolOnly")) sourceSets.getByName("test").java.srcDir("src/graphicsTest/java")
    buildTypes { release { isMinifyEnabled = false } }
}
dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.camera:camera-core:1.4.1")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("androidx.exifinterface:exifinterface:1.3.7")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    if (!project.hasProperty("protocolOnly")) testImplementation("org.robolectric:robolectric:4.14.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
