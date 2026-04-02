let _token = null;
let _tokenExp = 0;

async function getKgToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const url = process.env.KERJOO_URL;
  const r = await fetch(`${url}/auth`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({email:process.env.KERJOO_EMAIL, password:process.env.KERJOO_PASSWORD})
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Gagal login Kerjoo');
  _token = d.access_token;
  _tokenExp = Date.now() + 23*60*60*1000;
  return _token;
}

async function kg(path) {
  const t = await getKgToken();
  const r = await fetch(process.env.KERJOO_URL+path, {headers:{'Authorization':'Bearer '+t}});
  return r.json();
}

async function kgAll(path) {
  const first = await kg(path+(path.includes('?')?'&':'?')+'per_page=100&page=1');
  const rows = first.data||[];
  const last = first.meta?.last_page||1;
  for(let p=2;p<=last;p++){
    const d = await kg(path+(path.includes('?')?'&':'?')+'per_page=100&page='+p);
    rows.push(...(d.data||[]));
  }
  return rows;
}

module.exports = { getKgToken, kg, kgAll };
