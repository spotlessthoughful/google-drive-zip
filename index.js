const fsPromises = require('fs').promises;
const fs = require('fs');
const path = require('path');
const process = require('process');
const {authenticate} = require('@google-cloud/local-auth');
const {google} = require('googleapis');
const admZip = require('adm-zip');
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const folderIDs = []
let folderContents = [];
const keyword = 'Books';


async function loadSavedCredentialsIfExist() {
    try {
        const content = await fsPromises.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content.toString());
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
}

async function saveCredentials(client) {
    const content = await fsPromises.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content.toString());
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fsPromises.writeFile(TOKEN_PATH, payload);
}

async function authorize() {
    let client = await loadSavedCredentialsIfExist();
    if (client) {
        return client;
    }
    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
    });
    if (client.credentials) {
        await saveCredentials(client);
    }
    return client;
}

async function listFoldersWithKeyword(authClient) {
    const drive = google.drive({version: 'v3', auth: authClient});
    try {
        let queryString = `name contains \'${keyword}\' and mimeType = \'application/vnd.google-apps.folder\'`;
        const res = await drive.files.list({
            q: queryString,
            fields: 'nextPageToken, files(id, name)',
            spaces: 'drive',
        });
        for (const file of res.data.files) {
            folderIDs.push(file.id);
        }
        console.log(folderIDs);
        return res.data.files;
    } catch (err) {
        console.error('The API returned an error: ' + err);
        throw err;
    }
}

async function listFiles(authClient) {
    for (const folderID of folderIDs) {
        const queryString = `'${folderID}' in parents and name contains \'.pdf\'`;
        const drive = google.drive({version: 'v3', auth: authClient});
        const res = await drive.files.list({
            fields: 'nextPageToken, files(id, name)',
            q: queryString,
        });
        const files = res.data.files;
        if (files.length === 0) {
            console.log('No files found.');
            continue;
        }
        let folderFiles = {
            FolderID: folderID,
            Files: files
        }
        folderContents.push(folderFiles);
    }
}

async function downloadFiles() {
    let client = await authorize();
    const drive = google.drive({version: 'v3', auth: client});
    for (const folder of folderContents) {
        console.log(`Downloading files from folder ${folder.FolderID}`);
        if (!fs.existsSync(folder.FolderID)) {
            try {
                fs.mkdirSync(folder.FolderID);
            } catch (err) {
                console.log(err);
            }
        }
        for (const file of folder.Files) {
            console.log(`Downloading file ${file.name}`);
            try {
                const dest = fs.createWriteStream(path.join(process.cwd(), folder.FolderID, file.name));
                const downloadedFile = await drive.files.get({fileId: file.id, alt: 'media', headers: { 'Accept-Encoding': 'gzip'}}, {responseType: 'stream'});
                downloadedFile.data.on('end', () => {
                    console.log(`Download ${file.name} complete`);
                }).on('error', err => {
                    console.log('Error during download');
                    console.log(err);
                }).pipe(dest);
            } catch (err) {
                console.log(err);
            }
        }
    }
}

async function createZip() {
    for (const folder of folderContents) {
        console.log(`Creating zip for folder ${folder.FolderID}`);
        for (const file of folder.Files) {
            const zip = new admZip();
            zip.addLocalFile(path.join(process.cwd(), folder.FolderID, file.name));
            const fileName = file.name.replace('.pdf', '.zip');
            zip.writeZip(path.join(process.cwd(), folder.FolderID, fileName), (err) => {
                if (err) {
                    console.log(err);
                } else {
                    console.log(`Zip file ${fileName} created`);
                }
            });
        }
    }
}

async function uploadZip() {
    let client = await authorize();
    const drive = google.drive({version: 'v3', auth: client});
    for (const folder of folderContents) {
        console.log(`Uploading zip for folder ${folder.FolderID}`);
        for (const file of folder.Files) {
            const fileName = file.name.replace('.pdf', '.zip');
            const fileMetadata = {
                'name': fileName,
                parents: [folder.FolderID]
            };
            const media = {
                mimeType: 'application/zip',
                body: fs.createReadStream(path.join(process.cwd(), folder.FolderID, fileName))
            };
            try {
                await drive.files.create({
                    resource: fileMetadata,
                    media: media,
                    fields: 'id'
                });
                console.log(`Zip file ${fileName} uploaded`);
            } catch (err) {
                console.log(err);
            }
        }
    }
}

authorize().then(listFoldersWithKeyword).then(listFiles).then(downloadFiles).then(createZip).then(uploadZip).catch(console.error);
