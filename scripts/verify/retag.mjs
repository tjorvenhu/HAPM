// Kopiert in der lokalen Registry das Manifest eines Tags auf einen anderen,
// ohne dass sich lokal ein Tag bewegt: so sieht ein neues Abbild für einen
// laufenden Stack aus.
//   node retag.mjs <repo> <von> <nach>
const [repo, from, to] = process.argv.slice(2);
const base = `http://localhost:5000/v2/${repo}/manifests`;
const accept = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const res = await fetch(`${base}/${from}`, { headers: { Accept: accept } });
if (!res.ok) throw new Error(`GET ${from}: ${res.status}`);
const body = Buffer.from(await res.arrayBuffer());
const type = res.headers.get('content-type');
const put = await fetch(`${base}/${to}`, { method: 'PUT', headers: { 'Content-Type': type }, body });
console.log(`${from} -> ${to}: ${put.status} ${put.headers.get('docker-content-digest')}`);
