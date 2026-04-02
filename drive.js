const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Authentification via Service Account
const auth = new google.auth.GoogleAuth({
  keyFile: 'anak-requests-7898203eba71.json',
  scopes: ['https://www.googleapis.com/auth/drive']
});

const drive = google.drive({ version: 'v3', auth });

/**
 * Crée ou récupère un dossier sur Google Drive / Shared Drive
 * @param {string} name - Nom du dossier
 * @param {string} parentId - ID du dossier parent
 * @returns {Promise<string>} - ID du dossier
 */
async function getOrCreateFolder(name, parentId) {
  try {
    // Cherche si le dossier existe déjà
    const res = await drive.files.list({
      q: `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id;
    }

    // Crée le dossier si inexistant
    const folder = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      },
      supportsAllDrives: true
    });

    return folder.data.id;
  } catch (err) {
    console.error('Erreur getOrCreateFolder:', err);
    throw err;
  }
}

/**
 * Upload un fichier local vers Google Drive / Shared Drive
 * @param {string} localPath - Chemin du fichier local
 * @param {string} fileName - Nom du fichier sur Drive
 * @param {string} folderId - ID du dossier parent
 * @returns {Promise<string>} - ID du fichier uploadé
 */
async function uploadFile(localPath, fileName, folderId) {
  try {
    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId]
      },
      media: {
        body: fs.createReadStream(localPath)
      },
      supportsAllDrives: true
    });

    // Supprime le fichier local après upload réussi
    fs.unlinkSync(localPath);

    return res.data.id;
  } catch (err) {
    console.error(`Erreur uploadFile pour ${fileName}:`, err);

    // Ne pas supprimer le fichier local si l'upload échoue
    throw err;
  }
}

async function uploadToYearCenterMonth(localPath, fileName, parentId, centerName, createdAt) {
  try {
    const date = new Date(createdAt);

    // 1. YEAR
    const year = date.getFullYear().toString();
    const yearFolderId = await getOrCreateFolder(year, parentId);

    // 2. CENTER
    const centerFolderId = await getOrCreateFolder(centerName, yearFolderId);

    // 3. MONTH (en lettres)
    const monthName = date.toLocaleString('en-US', { month: 'long' }); // April, May...
    const monthFolderId = await getOrCreateFolder(monthName, centerFolderId);

    // 4. Upload
    return await uploadFile(localPath, fileName, monthFolderId);

  } catch (err) {
    console.error('Erreur uploadToYearCenterMonth:', err);
    throw err;
  }
}

module.exports = { 
  getOrCreateFolder, 
  uploadFile,
  uploadToYearCenterMonth
};