-keepattributes JavascriptInterface
-keepclassmembers class com.rajavavapor.app.MainActivity$WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.rajavavapor.app.MainActivity$WebAppInterface { *; }
-keep class com.rajavavapor.app.PrinterManager { *; }
-keep class com.rajavavapor.app.PrinterManager$ReceiptData { *; }
-keep class com.rajavavapor.app.PrinterManager$ReceiptItem { *; }
