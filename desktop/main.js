const {app,BrowserWindow,shell}=require('electron');
const URL='https://wisdom-medical-accounting-production.up.railway.app/';
function createWindow(){const win=new BrowserWindow({width:1440,height:900,minWidth:1100,minHeight:700,show:false,autoHideMenuBar:true,webPreferences:{contextIsolation:true,sandbox:true}});win.loadURL(URL);win.once('ready-to-show',()=>win.show());win.webContents.setWindowOpenHandler(({url})=>{shell.openExternal(url);return {action:'deny'}})}
app.whenReady().then(()=>{createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()})});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
