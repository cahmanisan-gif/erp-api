# Raja Vapor Portal + POS

## Stack
- Backend: Node.js + Express, port 3000, PM2 (rajavavapor-api)
- Frontend: /var/www/rajavavapor/frontend/index.html (single file ~12000+ baris)
- Database: MySQL 8.0, db: rajavapor, user: root, pass: passwordkamu
- Domain: https://poinraja.com

## Struktur
- Backend routes: backend/src/routes/
- Frontend: frontend/index.html (satu file besar)
- Uploads: /var/www/rajavavapor/uploads/

## Key Commands
- Restart: pm2 restart rajavavapor-api
- Logs: pm2 logs rajavavapor-api --lines 20 --nostream
- DB: mysql -u root -ppasswordkamu rajavapor

## Cabang
- 46 cabang aktif (id 3=GUDANG-S, id 4=GUDANG-R, id 6-49=RV001-RV045)

## Pending Issues
- Export/import produk dengan stok semua cabang
- Automated backup Google Drive
- Absensi mandiri lepas dari Kerjoo
