package com.rajavavapor.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import java.io.IOException
import java.io.OutputStream
import java.util.UUID

/**
 * Manager koneksi Bluetooth ke printer thermal ESC/POS.
 * Support printer 58mm & 80mm (auto detect dari preferences).
 */
class PrinterManager(private val context: Context) {

    companion object {
        // UUID standar Serial Port Profile (SPP)
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

        // ESC/POS Commands
        val ESC_INIT       = byteArrayOf(0x1B, 0x40)               // Initialize printer
        val ESC_ALIGN_LEFT = byteArrayOf(0x1B, 0x61, 0x00)         // Align left
        val ESC_ALIGN_CENTER = byteArrayOf(0x1B, 0x61, 0x01)       // Align center
        val ESC_ALIGN_RIGHT = byteArrayOf(0x1B, 0x61, 0x02)        // Align right
        val ESC_BOLD_ON    = byteArrayOf(0x1B, 0x45, 0x01)         // Bold on
        val ESC_BOLD_OFF   = byteArrayOf(0x1B, 0x45, 0x00)         // Bold off
        val ESC_DOUBLE_ON  = byteArrayOf(0x1D, 0x21, 0x11)         // Double width+height
        val ESC_DOUBLE_OFF = byteArrayOf(0x1D, 0x21, 0x00)         // Normal size
        val ESC_FONT_SMALL = byteArrayOf(0x1B, 0x4D, 0x01)         // Font B (small)
        val ESC_FONT_NORMAL = byteArrayOf(0x1B, 0x4D, 0x00)        // Font A (normal)
        val ESC_CUT        = byteArrayOf(0x1D, 0x56, 0x41, 0x00)   // Paper cut
        val ESC_FEED       = byteArrayOf(0x1B, 0x64, 0x04)         // Feed 4 lines
        val LF             = byteArrayOf(0x0A)                      // Line feed

        // Print density / heating — kirim semua varian supaya kompatibel dgn berbagai printer
        // GS ( K: Epson-compatible density (1=light ... 8=darkest)
        fun densityCommand(level: Int): ByteArray {
            val n = level.coerceIn(1, 8).toByte()
            return byteArrayOf(0x1D, 0x28, 0x4B, 0x02, 0x00, 0x31, n)
        }
        // DC2 # n: Chinese printer density (0-15, higher=darker)
        fun densityCommandAlt(level: Int): ByteArray {
            val n = level.coerceIn(0, 15).toByte()
            return byteArrayOf(0x12, 0x23, n)
        }
        // ESC 7 n1 n2 n3: heating dots, heating time, heating interval
        // n1=max heating dots (0-255), n2=heating time (3-15, higher=darker), n3=interval
        fun heatingCommand(dots: Int = 64, time: Int = 255, interval: Int = 2): ByteArray {
            return byteArrayOf(0x1B, 0x37, dots.toByte(), time.toByte(), interval.toByte())
        }
    }

    private var btAdapter: BluetoothAdapter? = null
    private var btSocket: BluetoothSocket? = null
    private var outputStream: OutputStream? = null
    private var connectedDevice: BluetoothDevice? = null

    // Lebar karakter: 32 untuk 58mm, 48 untuk 80mm
    var charWidth: Int = 32
    var connectedDeviceName: String = ""
    // Print density: 1 (tipis) - 8 (tebal). Default 6 supaya jelas terbaca.
    var printDensity: Int = 6

    init {
        val btManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        btAdapter = btManager?.adapter
    }

    // ── Koneksi ──

    val isConnected: Boolean
        get() = btSocket?.isConnected == true

    @SuppressLint("MissingPermission")
    fun getPairedDevices(): List<Map<String, String>> {
        val adapter = btAdapter ?: return emptyList()
        if (!adapter.isEnabled) return emptyList()

        return adapter.bondedDevices
            .filter { it.bluetoothClass?.majorDeviceClass == 1536 || // Printer class
                      it.name?.lowercase()?.let { n ->
                          n.contains("print") || n.contains("pos") ||
                          n.contains("thermal") || n.contains("rpp") ||
                          n.contains("btp") || n.contains("spt") ||
                          n.contains("xp-") || n.contains("mpt") ||
                          n.contains("imin") || n.contains("epson") ||
                          n.contains("58") || n.contains("80")
                      } == true ||
                      true // Tampilkan semua paired devices
            }
            .map { mapOf("name" to (it.name ?: "Unknown"), "address" to it.address) }
    }

    @SuppressLint("MissingPermission")
    fun connect(address: String): Boolean {
        disconnect()
        val adapter = btAdapter ?: return false
        return try {
            val device = adapter.getRemoteDevice(address)
            adapter.cancelDiscovery()

            btSocket = device.createRfcommSocketToServiceRecord(SPP_UUID)
            btSocket?.connect()
            outputStream = btSocket?.outputStream
            connectedDevice = device
            connectedDeviceName = device.name ?: address

            // Save last connected device
            saveLastDevice(address)

            // Initialize printer + set density
            write(ESC_INIT)
            write(densityCommand(printDensity))
            write(densityCommandAlt(printDensity * 2))
            write(heatingCommand(64, 255, 2))
            true
        } catch (e: IOException) {
            // Fallback: coba reflection method untuk beberapa printer China
            try {
                val device = adapter.getRemoteDevice(address)
                val method = device.javaClass.getMethod("createRfcommSocket", Int::class.java)
                btSocket = method.invoke(device, 1) as BluetoothSocket
                btSocket?.connect()
                outputStream = btSocket?.outputStream
                connectedDevice = device
                connectedDeviceName = device.name ?: address
                saveLastDevice(address)
                write(ESC_INIT)
                write(densityCommand(printDensity))
                write(densityCommandAlt(printDensity * 2))
                write(heatingCommand(64, 255, 2))
                true
            } catch (_: Exception) {
                disconnect()
                false
            }
        }
    }

    fun disconnect() {
        try {
            outputStream?.close()
            btSocket?.close()
        } catch (_: IOException) {}
        outputStream = null
        btSocket = null
        connectedDevice = null
        connectedDeviceName = ""
    }

    fun autoConnect(): Boolean {
        val lastAddr = getLastDevice() ?: return false
        return connect(lastAddr)
    }

    private fun saveLastDevice(address: String) {
        context.getSharedPreferences("printer", Context.MODE_PRIVATE)
            .edit().putString("last_address", address).apply()
    }

    private fun getLastDevice(): String? {
        return context.getSharedPreferences("printer", Context.MODE_PRIVATE)
            .getString("last_address", null)
    }

    // ── Print Functions ──

    fun write(data: ByteArray) {
        outputStream?.write(data)
        outputStream?.flush()
    }

    fun printText(text: String) {
        write(text.toByteArray(Charsets.UTF_8))
        write(LF)
    }

    fun feedAndCut() {
        write(ESC_FEED)
        write(ESC_CUT)
    }

    fun printLine(char: Char = '-') {
        printText(String(CharArray(charWidth) { char }))
    }

    fun printDoubleLine() {
        printLine('=')
    }

    /** Print 2 kolom: kiri rata kiri, kanan rata kanan */
    fun printColumns(left: String, right: String) {
        val space = charWidth - left.length - right.length
        if (space > 0) {
            printText(left + " ".repeat(space) + right)
        } else {
            printText(left)
            write(ESC_ALIGN_RIGHT)
            printText(right)
            write(ESC_ALIGN_LEFT)
        }
    }

    /** Print 3 kolom: nama, qty, harga */
    fun print3Columns(col1: String, col2: String, col3: String) {
        val c2w = 5
        val c3w = 12
        val c1w = charWidth - c2w - c3w
        val c1 = col1.take(c1w).padEnd(c1w)
        val c2 = col2.take(c2w).padStart(c2w)
        val c3 = col3.take(c3w).padStart(c3w)
        printText("$c1$c2$c3")
    }

    /**
     * Print struk transaksi POS dari JSON data.
     * Format JSON dari web:
     * {
     *   id, tanggal, kasir, cabang,
     *   items: [{nama, qty, harga, subtotal}],
     *   subtotal, diskon, total, bayar, kembalian,
     *   metode_bayar, catatan
     * }
     */
    fun printReceipt(data: ReceiptData) {
        write(ESC_INIT)

        // Set print density — kirim semua varian supaya kompatibel dgn berbagai merk printer
        write(densityCommand(printDensity))       // Epson-compatible
        write(densityCommandAlt(printDensity * 2)) // Chinese printers (scale 0-15)
        write(heatingCommand(64, 255, 2))          // Max heating time — paling efektif untuk printer murah

        // Header - nama toko
        write(ESC_ALIGN_CENTER)
        write(ESC_DOUBLE_ON)
        printText("RAJA VAPOR")
        write(ESC_DOUBLE_OFF)
        printText(data.cabang)
        write(ESC_FONT_SMALL)
        printText("poinraja.com")
        write(ESC_FONT_NORMAL)

        printDoubleLine()

        // Info transaksi
        write(ESC_ALIGN_LEFT)
        printColumns("No", ": ${data.id}")
        printColumns("Tgl", ": ${data.tanggal}")
        printColumns("Kasir", ": ${data.kasir}")
        if (data.metode_bayar.isNotEmpty()) {
            printColumns("Bayar", ": ${data.metode_bayar.uppercase()}")
        }

        printLine()

        // Items header
        write(ESC_BOLD_ON)
        print3Columns("Item", "Qty", "Subtotal")
        write(ESC_BOLD_OFF)
        printLine()

        // Items
        for (item in data.items) {
            // Jika nama panjang, print di baris sendiri
            if (item.nama.length > (charWidth - 17)) {
                printText(item.nama)
                print3Columns("", "${item.qty}x", formatRp(item.subtotal))
            } else {
                print3Columns(item.nama, "${item.qty}x", formatRp(item.subtotal))
            }
            // Harga per item (kecil)
            if (item.qty > 1) {
                write(ESC_FONT_SMALL)
                printText("  @ ${formatRp(item.harga)}")
                write(ESC_FONT_NORMAL)
            }
        }

        printLine()

        // Totals
        printColumns("Subtotal", formatRp(data.subtotal))
        if (data.diskon > 0) {
            printColumns("Diskon", "-${formatRp(data.diskon)}")
        }

        write(ESC_BOLD_ON)
        write(ESC_DOUBLE_ON)
        printColumns("TOTAL", formatRp(data.total))
        write(ESC_DOUBLE_OFF)
        write(ESC_BOLD_OFF)

        printLine()
        printColumns("Bayar", formatRp(data.bayar))
        printColumns("Kembali", formatRp(data.kembalian))

        if (data.catatan.isNotEmpty()) {
            printLine()
            write(ESC_FONT_SMALL)
            printText("Catatan: ${data.catatan}")
            write(ESC_FONT_NORMAL)
        }

        // Footer
        printDoubleLine()
        write(ESC_ALIGN_CENTER)
        write(ESC_FONT_SMALL)
        printText("Terima kasih!")
        printText("Barang yang sudah dibeli")
        printText("tidak dapat ditukar/dikembalikan")
        write(ESC_FONT_NORMAL)

        // Feed & cut
        feedAndCut()
    }

    private fun formatRp(amount: Long): String {
        val formatted = String.format("%,d", amount).replace(",", ".")
        return "Rp$formatted"
    }

    // Data classes
    data class ReceiptData(
        val id: String = "",
        val tanggal: String = "",
        val kasir: String = "",
        val cabang: String = "",
        val metode_bayar: String = "",
        val catatan: String = "",
        val items: List<ReceiptItem> = emptyList(),
        val subtotal: Long = 0,
        val diskon: Long = 0,
        val total: Long = 0,
        val bayar: Long = 0,
        val kembalian: Long = 0
    )

    data class ReceiptItem(
        val nama: String = "",
        val qty: Int = 0,
        val harga: Long = 0,
        val subtotal: Long = 0
    )
}
