import java.util.Properties

plugins {
    id("com.android.application")
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing comes from android/key.properties (never committed), written by CI from
// secrets. A release build without a complete one fails (see the check at the end), so a
// debug-signed APK is never mistaken for a release; -PallowDebugSigning=true (or
// ORG_GRADLE_PROJECT_allowDebugSigning=true in front of `flutter build`) signs it with the
// debug key on purpose. Debug builds never need key.properties.
val keyPropertiesFile = rootProject.file("key.properties")
val keyProperties = Properties().apply {
    if (keyPropertiesFile.exists()) keyPropertiesFile.inputStream().use { load(it) }
}
val signingKeys = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
val missingSigningKeys = signingKeys.filter { keyProperties.getProperty(it).isNullOrBlank() }
val allowDebugSigning = providers.gradleProperty("allowDebugSigning").orNull == "true"

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
        if (missingSigningKeys.isEmpty()) {
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

// Fails release builds (every flavour) before anything is compiled when release signing is
// not set up, instead of silently signing them with the debug key.
if (missingSigningKeys.isNotEmpty() && !allowDebugSigning) {
    val problem = if (keyPropertiesFile.exists()) {
        "${keyPropertiesFile.path} is missing ${missingSigningKeys.joinToString()}"
    } else {
        "${keyPropertiesFile.path} does not exist"
    }
    // Only this string is captured by the task action (configuration-cache safe).
    val message = "Release signing is not set up: $problem. It needs ${signingKeys.joinToString()} " +
        "(storeFile relative to android/app). To sign a release build with the debug key on " +
        "purpose, pass -PallowDebugSigning=true (with flutter: " +
        "ORG_GRADLE_PROJECT_allowDebugSigning=true flutter build apk --release ...)."
    val checkReleaseSigning = tasks.register("checkReleaseSigning") {
        doLast { throw GradleException(message) }
    }
    tasks.matching { it.name.startsWith("pre") && it.name.endsWith("ReleaseBuild") }.configureEach {
        dependsOn(checkReleaseSigning)
    }
}
