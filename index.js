const fs = require('fs/promises');
const path = require('path');

const { Octokit } = require("@octokit/core");
const fetch = require('node-fetch');

// the path where the gist data will be downloaded
const DOWNLOAD_DIRECTORY = path.join('.', 'downloaded');

// GISTS_PER_PAGE cannot be set higher than 100 (the GitHub API does not allow it)
const GISTS_PER_PAGE = 100;

// the number of pages of gists to request. increase this number of you have more than 300 gists.
const GIST_PAGE_LIMIT = 3;

// throw an error if there all gists were not downloaded (e.g., because GIST_PAGE_LIMIT was too low)
const ERROR_ON_INCOMPLETE_DOWNLOAD = true;

// throw an error if a gist has comments (it is safe to set this to false - i
// just want users to be aware that this script does _not_ download comments)
const ERROR_IF_GIST_FOUND_WITH_COMMENTS = true;

// set this to true if you want this script to delete all of your gists after
// it's finished downloading them. i do not recommend the use of this feature.
// it seems dangerous.
const DELETE_ALL_GISTS_AFTER_DOWNLOAD = false;

// don't touch this pls
const MAX_GISTS_TO_DOWNLOAD = GIST_PAGE_LIMIT * GISTS_PER_PAGE;


async function downloadTextFile(url, destination) {
  const response = await fetch(url);
  const contents = await response.text();
  await fs.writeFile(destination, contents);
}

async function saveObjectAsJsonFile(obj, destination) {
  const text = JSON.stringify(obj);
  await fs.writeFile(destination, text);
}

async function initOctokit() {
  try {
    const token = await fs.readFile('./token.txt', 'utf-8');
    return new Octokit({ auth: token.trim() });
  }
  catch (e) {
    throw new Error('please put your GitHub Personal Access Token in a file called token.txt in the same directory as this script\n\nif you don\'t have a GitHub Personal Access Token, you can create one here:\nhttps://github.com/settings/tokens/new\n');
  }
}

async function getAllGists(octokit) {
  let ret = [];
  for (let page = 1; page <= GIST_PAGE_LIMIT + 1; ++page) {
    const endpoint = 'GET /gists{?since,per_page,page}';
    const requestParams = { per_page: GISTS_PER_PAGE, page };
    const response = await octokit.request(endpoint, requestParams);
    const entries = response.data;
    if (entries.length > 0) {
      ret = ret.concat(entries);
    }
    else {
      ret.reverse();
      return ret;
    }
  }
  if (ERROR_ON_INCOMPLETE_DOWNLOAD) {
    throw new Error('you have more than ' + MAX_GISTS_TO_DOWNLOAD + ' gists. please edit the GIST_PAGE_LIMIT constant in the script.');
  }
}

function addDownloadedGistDirectoryName(gistInfo) {
  const indexPaddingSize = Math.log10(MAX_GISTS_TO_DOWNLOAD) + 1;
  const paddedIndex = (gistInfo.index + '').padStart(indexPaddingSize, '0');
  const paddedIndexLength = paddedIndex.length;

  const files = gistInfo.files;
  const shortHash = gistInfo.rawGistInfo.id.slice(0, 8);
  const shortHashLength = shortHash.length;

  const maxDirectoryNameLength = 42;
  const maxTextChunkLength = maxDirectoryNameLength - (2 + paddedIndexLength + shortHashLength);

  const descriptionTokens = (
    gistInfo.rawGistInfo.description
      .split(/\b/)
      .filter(token => /\w/.test(token))
      .map(token => token.toLowerCase())
  );

  if (files.length > 1) {
    const joinedDescriptionTokens = descriptionTokens.join('-').slice(0, maxTextChunkLength + 1);
    let descriptionChunk = joinedDescriptionTokens;
    if (descriptionChunk.length > maxTextChunkLength) {
      const indexOfLastHyphen = descriptionChunk.lastIndexOf('-');
      descriptionChunk = descriptionChunk.slice(0, indexOfLastHyphen);
    }
    gistInfo.downloadDirectoryName = `${paddedIndex}-${descriptionChunk}-${shortHash}`;
  }
  else {
    const fileNameChunk = (
      files[0].filename
        .replaceAll(/^\W+/g, '')
        .replaceAll(/\W+$/g, '')
        .replaceAll(/\W+/g, '-')
    ).slice(0, maxTextChunkLength);
    gistInfo.downloadDirectoryName = `${paddedIndex}-${fileNameChunk}-${shortHash}`;
  }
}

function tidyGistInfoEntryFiles(gistInfo) {
  gistInfo.files = [];
  const rawGistInfoFiles = gistInfo.rawGistInfo.files;
  for (const fileName in rawGistInfoFiles) {
    gistInfo.files.push(rawGistInfoFiles[fileName]);
  }
}

function makeGistInfoEntry(rawGistInfo, index) {
  const gistInfo = { index, rawGistInfo };
  tidyGistInfoEntryFiles(gistInfo);
  addDownloadedGistDirectoryName(gistInfo);
  if (rawGistInfo.comments > 0) {
    if (ERROR_IF_GIST_FOUND_WITH_COMMENTS) {
      throw new Error(`the gist at the following URL has comments:\n${gistInfo.rawGistInfo.html_url}\n\nedit this script and set ERROR_IF_GIST_FOUND_WITH_COMMENTS to false to disable this warning.\n\n`)
    }
  }
  return gistInfo;
}

function makeProcessedGistInfo(rawGistInfoEntries) {
  return rawGistInfoEntries.map(makeGistInfoEntry);
}

async function downloadEntry(gistInfo) {
  const dirName = path.join(DOWNLOAD_DIRECTORY, gistInfo.downloadDirectoryName);
  await fs.mkdir(dirName);

  const infoFromApiFilePath = path.join(dirName, 'info-from-api.json');
  await saveObjectAsJsonFile(gistInfo.rawGistInfo, infoFromApiFilePath);

  const contentsDirName = path.join(dirName, 'contents');
  await fs.mkdir(contentsDirName);

  for (let i = 0; i < gistInfo.files.length; ++i) {
    const fileFromGistInfo = gistInfo.files[i];
    const fileFromGistUrl = fileFromGistInfo.raw_url;
    const downloadPathToFileFromGist = path.join(contentsDirName, fileFromGistInfo.filename);
    await downloadTextFile(fileFromGistUrl, downloadPathToFileFromGist);
  }
}

async function downloadEntries(gistInfoEntries) {
  for (let i = 0; i < gistInfoEntries.length; ++i) {
    const gistInfo = gistInfoEntries[i];
    await downloadEntry(gistInfo);
  }
}

async function deleteAllGists(octokit, gistInfoEntries) {
  for (let i = 0; i < gistInfoEntries.length; ++i) {
    const gistInfo = gistInfoEntries[i];
    const params = { gist_id: gistInfo.rawGistInfo.id };
    await octokit.request('DELETE /gists/{gist_id}', params);
  }
}

async function main() {
  try {
    await fs.mkdir(DOWNLOAD_DIRECTORY);
  }
  catch (e) {
    if (e.code === 'EEXIST') {
      throw new Error('The download directory ' + DOWNLOAD_DIRECTORY + ' already exists. This can happen if the script is run twice in a row.\n\n');
    }
    throw e;
  }

  if (DELETE_ALL_GISTS_AFTER_DOWNLOAD) {
    console.log('You set the DELETE_ALL_GISTS_AFTER_DOWNLOAD to true.\n\nIf you change your mind, it is safe to kill this script with CTRL+C at any point. However, if the script already started deleting gists, they cannot be recovered.\n');
  }

  const octokit = await initOctokit();
  const rawGistInfoEntries = await getAllGists(octokit);
  const gistInfoEntries = makeProcessedGistInfo(rawGistInfoEntries);

  console.log('Downloading ' + gistInfoEntries.length + ' gists...');
  await downloadEntries(gistInfoEntries);
  console.log('Downloads finished.');

  if (DELETE_ALL_GISTS_AFTER_DOWNLOAD) {
    console.log('Deleting all gists. You can kill this script to minimize the damage if you change your mind.');
    await deleteAllGists(octokit, gistInfoEntries);
  }

  console.log('Done.');
}

main();
