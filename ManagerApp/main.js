const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1300,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: "Kiosk Management Console",
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    Menu.setApplicationMenu(null);

    // Load the local index.html. The app logic inside app.js will handle 
    // prompting for the Server URL via the setup overlay if it is not configured.
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    // If user requests a reset via command line, we can clear the serverUrl from localStorage.
    // However, localStorage is inside the renderer. We can send an IPC or clear it.
    createMainWindow();

    mainWindow.webContents.on('did-finish-load', () => {
        if (process.argv.includes('--reset')) {
            mainWindow.webContents.executeJavaScript('localStorage.removeItem("serverUrl"); location.reload();');
        }
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
