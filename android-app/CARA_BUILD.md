# Raja Vapor Android App - Cara Build APK

## Prasyarat
- Android Studio (versi terbaru)
- JDK 17+
- Koneksi internet (download dependencies)

## Langkah Build

### 1. Buka Project
- Buka Android Studio
- File > Open > pilih folder `android-app`
- Tunggu Gradle sync selesai (bisa 3-5 menit pertama kali)

### 2. Ganti Icon (Opsional)
- Klik kanan folder `res` > New > Image Asset
- Pilih logo Raja Vapor (dari `/var/www/rajavavapor/frontend/assets/logo.jpg`)
- Generate icon set otomatis

### 3. Build Debug APK (untuk testing)
- Menu: Build > Build Bundle(s) / APK(s) > Build APK(s)
- APK ada di: `app/build/outputs/apk/debug/app-debug.apk`
- Install ke HP via USB / kirim via WhatsApp

### 4. Build Release APK (untuk distribusi)
- Menu: Build > Generate Signed Bundle / APK
- Pilih APK
- Buat keystore baru (simpan baik-baik! Tidak bisa diganti)
- Build release
- APK ada di: `app/build/outputs/apk/release/app-release.apk`

## Cara Pakai di HP

### Pertama kali:
1. Install APK
2. Buka app Raja Vapor
3. Login seperti biasa di web
4. Pair printer Bluetooth di Settings HP > Bluetooth

### Print Struk:
- Dari web portal, klik tombol Print (yang sudah dimodifikasi)
- App otomatis detect dan connect ke printer
- Struk tercetak via Bluetooth

## Cara Integrasi Print di Web Portal

Di frontend (index.html), tambahkan pengecekan:

```javascript
// Cek apakah berjalan di app Android
if (window.RajaVaporPrinter && RajaVaporPrinter.isAvailable()) {
  // Tampilkan tombol print Bluetooth
  // Contoh print struk:
  RajaVaporPrinter.printReceipt({
    id: 'TRX-123',
    tanggal: '15/01/2024 14:30',
    kasir: 'Budi',
    cabang: 'RV001 - Toko Satu',
    metode_bayar: 'cash',
    items: [
      {nama: 'Liquid ABC 30ml', qty: 2, harga: 50000, subtotal: 100000}
    ],
    subtotal: 100000,
    diskon: 0,
    total: 100000,
    bayar: 100000,
    kembalian: 0
  });
}
```

## API Bridge (JavaScript)

| Fungsi | Keterangan |
|--------|-----------|
| `RajaVaporPrinter.isAvailable()` | Cek apakah di dalam app Android |
| `RajaVaporPrinter.isConnected()` | Cek printer terhubung |
| `RajaVaporPrinter.getPairedDevices()` | List device BT yang di-pair |
| `RajaVaporPrinter.connect(address)` | Connect ke printer |
| `RajaVaporPrinter.disconnect()` | Disconnect |
| `RajaVaporPrinter.autoConnect()` | Auto-connect printer terakhir |
| `RajaVaporPrinter.printReceipt(data)` | Print struk transaksi |
| `RajaVaporPrinter.printText(text)` | Print teks biasa |
| `RajaVaporPrinter.testPrint()` | Test print |
| `RajaVaporPrinter.showPrinterDialog(cb)` | Dialog pilih printer |
| `RajaVaporPrinter.setPaperWidth(58/80)` | Set lebar kertas |
| `RajaVaporPrinter.enableBluetooth()` | Aktifkan Bluetooth |
