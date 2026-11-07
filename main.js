// TaskMeter Pro Studio — Desktop Application Entry Point (Electron)
const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, shell, Notification } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Hardware acceleration & performance settings
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'TaskMeter Pro Studio',
    icon: path.join(__dirname, 'logo-240x240.jpg'),
    backgroundColor: '#07090e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      spellcheck: false
    }
  });

  // Load the local index.html app
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle close event to minimize to tray instead of quitting if preferred
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (tray && process.platform === 'win32') {
        tray.displayBalloon({
          title: 'TaskMeter Running in Background',
          content: 'Your timer is still running. Click the TaskMeter tray icon to restore.',
          iconType: 'info'
        });
      }
    }
    return false;
  });

  // Open external links in default browser instead of new Electron windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  setupTray();
  setupGlobalShortcuts();
}

function setupTray() {
  if (tray) return;

  const iconPath = path.join(__dirname, 'logo-240x240.jpg');
  try {
    tray = new Tray(iconPath);
  } catch (err) {
    console.error('Tray icon initialization fallback:', err);
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open TaskMeter Pro Studio',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Toggle Timer (Start / Pause)',
      accelerator: 'CmdOrCtrl+Alt+Space',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('desktop:toggle-timer');
        }
      }
    },
    {
      label: 'Open Client Stream Portal',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send('desktop:switch-view', 'client');
        }
      }
    },
    {
      label: 'Invoices & SOWs',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send('desktop:switch-view', 'invoices');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit TaskMeter Pro',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('TaskMeter Pro Studio — Precision Freelance Time Clock');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

function setupGlobalShortcuts() {
  // Global Shortcut: Ctrl+Alt+Space (or Cmd+Alt+Space on Mac) to start/pause timer from any app
  globalShortcut.register('CommandOrControl+Alt+Space', () => {
    if (mainWindow) {
      mainWindow.webContents.send('desktop:toggle-timer');
    }
  });

  // Global Shortcut: Ctrl+Alt+M to focus/bring TaskMeter to front
  globalShortcut.register('CommandOrControl+Alt+M', () => {
    if (mainWindow) {
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// IPC Handlers for communication between renderer and main process
ipcMain.on('desktop:notify', (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({
      title: title || 'TaskMeter Pro Studio',
      body: body || 'Milestone notification',
      icon: path.join(__dirname, 'logo-240x240.jpg')
    }).show();
  }
});

ipcMain.on('desktop:update-tray-title', (event, titleText) => {
  if (tray) {
    tray.setToolTip(`TaskMeter Pro: ${titleText}`);
  }
});

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
