/**
 * Raja Vapor - Print Bridge
 * Inject ke WebView untuk menghubungkan web portal dengan native Bluetooth printer.
 *
 * Penggunaan dari web:
 *   if (window.RajaVaporPrinter) {
 *     RajaVaporPrinter.connect('XX:XX:XX:XX:XX:XX');
 *     RajaVaporPrinter.printReceipt({...});
 *   }
 */
(function() {
  if (window.RajaVaporPrinter) return; // Sudah di-inject

  const bridge = window.AndroidBridge;
  if (!bridge) return; // Bukan di dalam Android app

  window.RajaVaporPrinter = {

    /** Cek apakah berjalan di app Android */
    isAvailable: function() {
      return !!(bridge && bridge.isAndroidApp());
    },

    /** Cek apakah printer terhubung */
    isConnected: function() {
      try { return bridge.isPrinterConnected(); } catch(e) { return false; }
    },

    /** Nama printer yang terhubung */
    getConnectedName: function() {
      try { return bridge.getConnectedPrinter(); } catch(e) { return ''; }
    },

    /** Daftar perangkat Bluetooth yang sudah di-pair */
    getPairedDevices: function() {
      try { return JSON.parse(bridge.getPairedDevices()); } catch(e) { return []; }
    },

    /** Connect ke printer (by MAC address) */
    connect: function(address) {
      try { return bridge.connectPrinter(address); } catch(e) { return false; }
    },

    /** Disconnect */
    disconnect: function() {
      try { bridge.disconnectPrinter(); } catch(e) {}
    },

    /** Auto-connect ke printer terakhir */
    autoConnect: function() {
      try { return bridge.autoConnect(); } catch(e) { return false; }
    },

    /** Set lebar kertas: 58 atau 80 */
    setPaperWidth: function(mm) {
      try { bridge.setPaperWidth(mm); } catch(e) {}
    },

    /** Aktifkan Bluetooth */
    enableBluetooth: function() {
      try { bridge.enableBluetooth(); } catch(e) {}
    },

    /**
     * Print struk transaksi.
     * @param {Object} data - { id, tanggal, kasir, cabang, metode_bayar, catatan,
     *                          items: [{nama, qty, harga, subtotal}],
     *                          subtotal, diskon, total, bayar, kembalian }
     */
    printReceipt: function(data) {
      try { return bridge.printReceipt(JSON.stringify(data)); } catch(e) { return false; }
    },

    /** Print teks biasa */
    printText: function(text) {
      try { return bridge.printText(text); } catch(e) { return false; }
    },

    /** Test print */
    testPrint: function() {
      try { return bridge.printTestPage(); } catch(e) { return false; }
    },

    /**
     * Helper: tampilkan dialog pilih printer lalu connect.
     * Callback dipanggil dengan true/false.
     */
    showPrinterDialog: function(callback) {
      var devices = this.getPairedDevices();
      if (!devices.length) {
        alert('Tidak ada perangkat Bluetooth yang di-pair.\nPair printer dulu di Settings > Bluetooth.');
        if (callback) callback(false);
        return;
      }

      var msg = 'Pilih printer:\n\n';
      devices.forEach(function(d, i) {
        msg += (i+1) + '. ' + d.name + '\n';
      });
      var choice = prompt(msg, '1');
      if (!choice) { if (callback) callback(false); return; }

      var idx = parseInt(choice) - 1;
      if (idx < 0 || idx >= devices.length) {
        alert('Pilihan tidak valid.');
        if (callback) callback(false);
        return;
      }

      var ok = this.connect(devices[idx].address);
      if (callback) callback(ok);
    }
  };

  // Auto-connect saat load
  try { bridge.autoConnect(); } catch(e) {}

  console.log('[RajaVapor] Print bridge loaded. Printer available:', window.RajaVaporPrinter.isAvailable());
})();
