// Revised index.js — Java‑only, single output file "ips"
// ─────────────────────────────────────────────────────────
// ‑ Removes Bedrock scanning
// ‑ All passes append to one binary file (ips)
// ‑ Pushes only that file to Git if enabled

const fs = require('fs');
const { spawn } = require('child_process'); // kept in case masscan.js still spawns
const simpleGit = require('simple-git');
const minecraftCheck = require('./minecraftCheck.js');
const masscan = require('./masscan.js');
const config = require('./config.json');

/*
  Pipeline
  1. scanDefaultPort   → port 25565 whole IPv4
  2. scanNearPorts     → extra MC ports on /24s of first hits (optional)
  3. scanAllPorts      → every other port on confirmed IPs (optional)
  Every pass writes through minecraftCheck → "ips" (binary 6‑byte records)
*/

async function main() {
  if (config.scanPort) await scanDefaultPort();
  if (config.scan24s)  await scanNearPorts();
  if (config.scanAllPorts) await scanAllPorts();
  if (config.git.push) await pushToGit();
  process.exit();
}

// ─────────────────────────────────────────────────────────
// 1) Full‑net scan on default Java port 25565
// ─────────────────────────────────────────────────────────
async function scanDefaultPort() {
  const cmd = `${config.sudo ? 'sudo ' : ''}masscan -p 25565 0.0.0.0/0 --rate=${config.packetLimit} --excludefile exclude.conf -oJ -`;
  await masscan(cmd, 'ipsUnfiltered_pass1', '[1] [Java]');
  await minecraftCheck('ipsUnfiltered_pass1', 'ips', '[1] [Java]');
}

// ─────────────────────────────────────────────────────────
// 2) Scan neighbour ports on discovered /24s
// ─────────────────────────────────────────────────────────
async function scanNearPorts() {
  await buildInclude24s('ips');

  const cmd = `${config.sudo ? 'sudo ' : ''}masscan -p 25500-25564,25566-25700 --include-file includeFile.txt --rate=${config.packetLimit} --excludefile exclude.conf -oJ -`;
  await masscan(cmd, 'ipsUnfiltered_pass2', '[2] [Java]');
  await minecraftCheck('ipsUnfiltered_pass2', 'ips', '[2] [Java]', 'java', 'a');
}

// ─────────────────────────────────────────────────────────
// 3) Scan all remaining ports on confirmed IPs
// ─────────────────────────────────────────────────────────
async function scanAllPorts() {
  await buildIncludeIps('ips');

  const cmd = `${config.sudo ? 'sudo ' : ''}masscan -p 1024-25499,25701-65535 --include-file includeFile.txt --rate=${config.packetLimit} --excludefile exclude.conf -oJ -`;
  await masscan(cmd, 'ipsUnfiltered_pass3', '[3] [Java]');
  await minecraftCheck('ipsUnfiltered_pass3', 'ips', '[3] [Java]', 'java', 'a');
}

// ─────────────────────────────────────────────────────────
// Helpers to generate include lists for masscan
// ─────────────────────────────────────────────────────────
function buildInclude24s(file) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream('includeFile.txt');
    const size = fs.statSync(file).size;
    const stream = fs.createReadStream(file);
    const seen = new Set();
    let remainder = null;

    stream.on('data', chunk => {
      if (remainder) chunk = Buffer.concat([remainder, chunk]);
      for (let i = 0; i < Math.floor(chunk.length / 6) * 6; i += 6) {
        const key = chunk.subarray(i, i + 3).toString('hex');
        if (seen.has(key)) continue;
        seen.add(key);
        out.write(`${chunk[i]}.${chunk[i+1]}.${chunk[i+2]}.0/24\n`);
      }
      remainder = chunk.length % 6 === 0 ? null : chunk.slice(Math.floor(chunk.length / 6) * 6);
    }).on('end', () => { out.end(); resolve(); }).on('error', reject);
  });
}

function buildIncludeIps(file) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream('includeFile.txt');
    const stream = fs.createReadStream(file);
    const seen = new Set();
    let remainder = null;

    stream.on('data', chunk => {
      if (remainder) chunk = Buffer.concat([remainder, chunk]);
      for (let i = 0; i < Math.floor(chunk.length / 6) * 6; i += 6) {
        const key = chunk.subarray(i, i + 4).toString('hex');
        if (seen.has(key)) continue;
        seen.add(key);
        out.write(`${chunk[i]}.${chunk[i+1]}.${chunk[i+2]}.${chunk[i+3]}\n`);
      }
      remainder = chunk.length % 6 === 0 ? null : chunk.slice(Math.floor(chunk.length / 6) * 6);
    }).on('end', () => { out.end(); resolve(); }).on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────
// Optional Git push
// ─────────────────────────────────────────────────────────
async function pushToGit() {
  try {
    const git = simpleGit();
    await git.addConfig('user.name', config.git.username);
    await git.addConfig('user.email', config.git.email);
    if ((await git.getRemotes()).some(r => r.name === 'origin')) {
      await git.removeRemote('origin');
    }
    await git.addRemote('origin', config.git.url);
    await git.add('ips');
    await git.commit(String(Math.floor(Date.now() / 1000)));
    await git.push('origin', config.git.branch);
    console.log('Pushed to repo.');
  } catch (err) {
    console.error('Error pushing to repo:', err);
  }
}

main();
