import java.util.Properties

plugins {
    id("com.android.application")
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing comes from android/key.properties (never committed), written by CI from
// secrets; without it a release build falls back to the debug key so local builds still run.
val keyProperties = Properties().apply {
    val file = rootProject.file("key.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.magickagency.agent"
    // permission_handler_android's AAR requires apps that use it to compile against API 37.
    // Compile SDK only decides which APIs compile; runtime behaviour follows targetSdk below.
    compileSdk = maxOf(flutter.compileSdkVersion, 37)
    ndkVersion = flutter.ndkVersion

    buildFeatures {
        // AGP 9 turns resValue off by default; the flavours below name the app with it.
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // flutter_local_notifications uses java.time on older API levels.
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        applicationId = "com.magickagency.agent"
        // Android 9: the audio routing and foreground-service rules the agent app relies on
        // are manageable from here, and agents' phones are newer in practice (proposal, decision 6).
        minSdk = 28
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // One flavour per environment so dev, staging and production install side by side.
    // `appLinkHost` is the console's host: invite links (https://<host>/agency/join/<token>)
    // open the app (App Links, verified through /.well-known/assetlinks.json on that host).
    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            resValue("string", "app_name", "MA Agent Dev")
            manifestPlaceholders["appLinkHost"] = "localhost"
        }
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
            resValue("string", "app_name", "MA Agent Staging")
            manifestPlaceholders["appLinkHost"] = "staging.agency.example.invalid"
        }
        create("prod") {
            dimension = "env"
            resValue("string", "app_name", "Magick Agency")
            manifestPlaceholders["appLinkHost"] = "agency.example.invalid"
        }
    }

    signingConfigs {
        if (keyProperties.isNotEmpty()) {
            create("release") {
                storeFile = file(keyProperties.getProperty("storeFile"))
                storePassword = keyProperties.getProperty("storePassword")
                keyAlias = keyProperties.getProperty("keyAlias")
                keyPassword = keyProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            isMinifyEnabled = true
            isShrinkResources = true
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}

flutter {
    source = "../.."
}
