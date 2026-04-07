package com.rajavavapor.app

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.*
import android.widget.Button
import android.widget.LinearLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

class MainActivity : AppCompatActivity() {

    companion object {
        private const val BASE_URL = "https://poinraja.com"
    }

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var offlineLayout: LinearLayout
    private lateinit var printerManager: PrinterManager
    private var printBridgeJs: String = ""

    // Bluetooth permission launcher (Android 12+)
    private val btPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { /* no-op, just need the grant */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        printerManager = PrinterManager(this)

        // Load print bridge JS from assets
        printBridgeJs = assets.open("print_bridge.js")
            .bufferedReader().use { it.readText() }

        webView = findViewById(R.id.webView)
        swipeRefresh = findViewById(R.id.swipeRefresh)
        offlineLayout = findViewById(R.id.offlineLayout)

        // Request BT permissions on Android 12+
        requestBluetoothPermissions()

        setupWebView()
        setupSwipeRefresh()
        setupRetryButton()

        if (isOnline()) {
            loadUrl(BASE_URL)
        } else {
            showOffline()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            userAgentString = webView.settings.userAgentString + " RajaVaporApp/1.0"
        }

        // Add JavaScript interface — bridges web JS to native Kotlin
        webView.addJavascriptInterface(WebAppInterface(), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                showOnline()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                swipeRefresh.isRefreshing = false
                // Inject print bridge JS
                if (printBridgeJs.isNotEmpty()) {
                    view?.evaluateJavascript(printBridgeJs, null)
                }
                // Inject app-mode class to body for mobile-optimized CSS
                view?.evaluateJavascript(
                    "document.body.classList.add('app-mode');", null
                )
            }

            override fun onReceivedError(
                view: WebView?, request: WebResourceRequest?, error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    showOffline()
                }
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?, request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString() ?: return false
                // Keep poinraja.com in WebView, open external links in browser
                return if (url.contains("poinraja.com")) {
                    false
                } else {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    } catch (_: Exception) {}
                    true
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                return super.onJsAlert(view, url, message, result)
            }

            override fun onJsPrompt(
                view: WebView?, url: String?, message: String?,
                defaultValue: String?, result: JsPromptResult?
            ): Boolean {
                return super.onJsPrompt(view, url, message, defaultValue, result)
            }
        }
    }

    private fun setupSwipeRefresh() {
        swipeRefresh.setColorSchemeColors(
            ContextCompat.getColor(this, R.color.brand_red)
        )
        swipeRefresh.setOnRefreshListener {
            if (isOnline()) {
                webView.reload()
            } else {
                swipeRefresh.isRefreshing = false
                showOffline()
            }
        }
    }

    private fun setupRetryButton() {
        findViewById<Button>(R.id.btnRetry).setOnClickListener {
            if (isOnline()) {
                showOnline()
                loadUrl(BASE_URL)
            }
        }
    }

    private fun loadUrl(url: String) {
        webView.loadUrl(url)
    }

    private fun showOffline() {
        webView.visibility = View.GONE
        offlineLayout.visibility = View.VISIBLE
    }

    private fun showOnline() {
        webView.visibility = View.VISIBLE
        offlineLayout.visibility = View.GONE
    }

    private fun isOnline(): Boolean {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun requestBluetoothPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val needed = arrayOf(
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN
            ).filter {
                ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
            }.toTypedArray()
            if (needed.isNotEmpty()) {
                btPermLauncher.launch(needed)
            }
        }
    }

    // ── Back navigation: go back in WebView history first ──

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        printerManager.disconnect()
        webView.destroy()
        super.onDestroy()
    }

    // ═══════════════════════════════════════════════════════════
    //  WebAppInterface — JS bridge called by print_bridge.js
    //  window.AndroidBridge.xxx() in JS → this class methods
    // ═══════════════════════════════════════════════════════════

    inner class WebAppInterface {

        @JavascriptInterface
        fun isAndroidApp(): Boolean = true

        @JavascriptInterface
        fun isPrinterConnected(): Boolean = printerManager.isConnected

        @JavascriptInterface
        fun getConnectedPrinter(): String = printerManager.connectedDeviceName

        @JavascriptInterface
        fun getPairedDevices(): String {
            return try {
                val devices = printerManager.getPairedDevices()
                com.google.gson.Gson().toJson(devices)
            } catch (_: Exception) { "[]" }
        }

        @JavascriptInterface
        fun connectPrinter(address: String): Boolean {
            return try {
                printerManager.connect(address)
            } catch (_: Exception) { false }
        }

        @JavascriptInterface
        fun disconnectPrinter() {
            printerManager.disconnect()
        }

        @JavascriptInterface
        fun autoConnect(): Boolean {
            return try {
                printerManager.autoConnect()
            } catch (_: Exception) { false }
        }

        @JavascriptInterface
        fun setPaperWidth(mm: Int) {
            printerManager.charWidth = if (mm >= 80) 48 else 32
        }

        @JavascriptInterface
        fun setPrintDensity(level: Int) {
            printerManager.printDensity = level.coerceIn(1, 8)
            // Langsung kirim ke printer jika connected
            if (printerManager.isConnected) {
                try {
                    printerManager.write(PrinterManager.densityCommand(printerManager.printDensity))
                    printerManager.write(PrinterManager.densityCommandAlt(printerManager.printDensity * 2))
                    printerManager.write(PrinterManager.heatingCommand(64, 255, 2))
                } catch (_: Exception) {}
            }
        }

        @JavascriptInterface
        fun getPrintDensity(): Int = printerManager.printDensity

        @SuppressLint("MissingPermission")
        @JavascriptInterface
        fun enableBluetooth() {
            try {
                val intent = Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)
                startActivity(intent)
            } catch (_: Exception) {}
        }

        @JavascriptInterface
        fun printReceipt(json: String): Boolean {
            return try {
                val gson = com.google.gson.Gson()
                val data = gson.fromJson(json, PrinterManager.ReceiptData::class.java)
                printerManager.printReceipt(data)
                true
            } catch (_: Exception) { false }
        }

        @JavascriptInterface
        fun printText(text: String): Boolean {
            return try {
                printerManager.printText(text)
                true
            } catch (_: Exception) { false }
        }

        @JavascriptInterface
        fun printTestPage(): Boolean {
            return try {
                printerManager.write(PrinterManager.ESC_INIT)
                printerManager.write(PrinterManager.ESC_ALIGN_CENTER)
                printerManager.write(PrinterManager.ESC_DOUBLE_ON)
                printerManager.printText("RAJA VAPOR")
                printerManager.write(PrinterManager.ESC_DOUBLE_OFF)
                printerManager.printText("Test Print OK")
                printerManager.printDoubleLine()
                printerManager.write(PrinterManager.ESC_ALIGN_LEFT)
                printerManager.printText("Printer: ${printerManager.connectedDeviceName}")
                printerManager.printText("Width: ${printerManager.charWidth} chars")
                printerManager.printText("Time: ${java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", java.util.Locale("id")).format(java.util.Date())}")
                printerManager.printDoubleLine()
                printerManager.write(PrinterManager.ESC_ALIGN_CENTER)
                printerManager.printText("poinraja.com")
                printerManager.feedAndCut()
                true
            } catch (_: Exception) { false }
        }
    }
}
