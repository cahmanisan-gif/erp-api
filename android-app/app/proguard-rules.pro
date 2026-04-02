-keepattributes JavascriptInterface
-keepclassmembers class com.rajavavapor.app.WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.rajavavapor.app.WebAppInterface { *; }
