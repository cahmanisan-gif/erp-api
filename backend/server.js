require('dotenv').config({ path: __dirname + '/.env' });
const app  = require('./src/app');
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('Server Raja Vapor berjalan di port ' + PORT);
});
