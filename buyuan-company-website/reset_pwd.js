var bc = require('bcryptjs');
var mp = require('mysql2/promise');
(async function(){
  var h = await bc.hash('wzz123@#', 12);
  var p = await mp.createPool({host:'127.0.0.1',user:'buqin_app',password:'Buqin@2026!',database:'buqin_business'});
  await p.execute('UPDATE users SET password_hash=? WHERE username=?',[h,'admin']);
  console.log('pwd reset');
  await p.end();
})();
