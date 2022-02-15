import { cheerio, TagElement } from "https://deno.land/x/cheerio@1.0.4/mod.ts";
import * as path from "https://deno.land/std@0.125.0/path/mod.ts";
import { createHash } from "https://deno.land/std@0.77.0/hash/mod.ts";
import * as b64 from 'https://deno.land/std@0.82.0/encoding/base64.ts';

if ((await Deno.permissions.query({ name: 'net' })).state !== 'granted') {
    throw new Error('--allow-net is required');
}

const outdir = Deno.args.find((flag) => flag.startsWith('--outdir='))?.substring(9) || 'mirror';
if ((await Deno.permissions.query({ name: 'write', path: outdir })).state !== 'granted') {
    throw new Error('--allow-write is required');
}

const readPermissionDesc = { name: 'read', path: outdir } as const;
const canReuseCache = (await Deno.permissions.query(readPermissionDesc)).state === 'granted' || (console.log('allow read to reuse cached files'), (await Deno.permissions.request(readPermissionDesc)).state === 'granted');
const shouldDownloadTiles = !Deno.args.includes('--no-tiles');
const shouldDownloadAssets = !Deno.args.includes('--no-assets');
const shouldDownloadZones = !Deno.args.includes('--no-zones');
const shouldDownloadZoneIcons = !Deno.args.includes('--no-zone-icons');
const refresh = Deno.args.includes('--refresh');

const origin = 'https://papunika.com';
const rootUrl = origin + '/map/';
const world = rootUrl + '/data/zones/us/overworld.json';
const assets: string[] = [
    'island',
    'islandPvP',
    'affinity',
    'astory',
    'food',
    'ingredient',
    'mokoko',
    'spassage',
    'viewpoint',
    'hstory',
    'minuet',
    'resonance',
    'monster',
    'boss',
    'boss',
    'notice',
    'merchant',
    'ogate',
    'ghost',
    'emarine',
    'smerchant',
    'cdotr',
    'cdotb',
    'cdotg',
];

function sanitizedBasename(url: string) {
    return path.basename(new URL(url).pathname).replace('.min.', '.').replace(/-\w+\.\w+\.\w+\./, '.').replace(/@.*$/, '');
}

function backoff(i: number): number {
    return Math.pow(2, i) * 250;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findExistingCachedFile(filepath: string): Promise<string | undefined>;
async function findExistingCachedFile(dir: string, name: string, ext: string): Promise<string | undefined>;
async function findExistingCachedFile(dir: string, name?: string, ext?: string): Promise<string | undefined> {
    if (!name) {
        name = path.basename(dir);
        dir = path.dirname(dir);
    }

    if (!ext) {
        ext = path.extname(name);
        name = path.basename(name, ext);
    }

    try {
        for await (const file of Deno.readDir(dir)) {
            if (
                file.name === name + ext ||
                file.name.startsWith(name) && file.name.endsWith(ext) && file.name.length === name.length + ext.length + 33
            ) {
                return file.name;
            }
        }
    } catch (err) {
        if (err.name !== 'NotFound' && err.name !== 'PermissionDenied') {
            console.warn(err);
        }
        return;
    }
}

async function embedCssUrls(url: string, contents: Uint8Array): Promise<Uint8Array> {
    let s = new TextDecoder().decode(contents);
    const resourceUrls = Array.from(new Set(Array.from(s.matchAll(/url\(((?!data:)[^)]+)\)/g), (m) => m[1])));
    for (const resourceUrl of resourceUrls) {
        if (resourceUrl.startsWith('#')) {
            continue;
        }

        let normalizedUrl = resourceUrl;
        if (!normalizedUrl.startsWith('http')) {
            normalizedUrl = new URL(normalizedUrl, url).href;
        }

        const res = await fetch(normalizedUrl);
        if (res.status !== 200) {
            throw new Error('bad status code: ' + res.status);
        }

        const mimeType = res.headers.get('content-type');
        if (!mimeType) {
            console.log('warning: no content-type header for ' + normalizedUrl);
        }

        s = s.replaceAll(`url(${resourceUrl})`, `url(data:${mimeType};base64,${b64.encode(await res.arrayBuffer())})`);
    }

    return new TextEncoder().encode(s);
}

function replaceJsPapunikaUrls(url: string, contents: Uint8Array): Uint8Array {
    return new TextEncoder().encode(new TextDecoder().decode(contents).replaceAll('"' + origin + '/', 'worldPath+"'));
}

async function cacheResourceFile(url: string, prefix = '/', mutate?: (url: string, contents: Uint8Array) => Promise<Uint8Array> | Uint8Array): Promise<string> {
    const sanitized = sanitizedBasename(url);
    const extname = path.extname(sanitized);
    const filename = path.basename(sanitized, extname);
    const writedir = path.join(outdir, prefix);

    const existing = canReuseCache && await findExistingCachedFile(writedir, filename, extname);
    if (existing && !refresh) {
        const reusepath = path.join(prefix, existing);
        console.log('reusing cached resource', reusepath);
        return reusepath;
    }

    let i = 0;
    while (true) {
        try {
            const res = await fetch(url);
            if (res.status !== 200) {
                throw new Error('bad status code: ' + res.status);
            }

            let contents = new Uint8Array(await res.arrayBuffer());
            if (mutate) {
                contents = await mutate(url, contents);
            }

            console.log('caching resource', url);
            const filenameWithHash = filename + '-' + createHash('md5').update(contents).toString('hex') + extname;
            const writepath = path.join(writedir, filenameWithHash);
            await Deno.mkdir(path.dirname(writepath), { recursive: true });
            await Deno.writeFile(writepath, contents);
            return path.join(prefix, filenameWithHash);
        } catch (err) {
            console.error('failed to cache ' + url + ':', err);
            if (existing) {
                const reusepath = path.join(prefix, existing);
                console.log('reusing cached resource', reusepath);
                return reusepath;
            }

            const time = backoff(i++);
            console.log(`retrying in ${time}ms`);
            await sleep(time);
            continue;
        }
    }
}

async function fetchRootPage(): Promise<string> {
    let i = 0;
    while (true) {
        try {
            const res = await fetch(rootUrl);
            if (res.status !== 200) {
                throw new Error('bad status code: ' + res.status);
            }
    
            return await res.text();
        } catch {
            const time = backoff(i++);
            console.log('failed to fetch root page, retrying in ' +  + 'ms');
            await sleep(time);
            continue;
        }
    }
}

const $ = cheerio.load(await fetchRootPage());

for (const link of $('head link[rel="stylesheet"]').toArray()) {
    if (link.type === 'tag' && !link.attribs.href.includes('fonts.googleapis.com')) {
        link.attribs.href = await cacheResourceFile(link.attribs.href, 'static/css', embedCssUrls);
    }
}

for (const script of $('head script').toArray()) {
    if ((script.type as string) === 'script' && (script as TagElement).attribs.src) {
        (script as TagElement).attribs.src = await cacheResourceFile((script as TagElement).attribs.src, 'static/js', (script as TagElement).attribs.src.includes('map.js') ? replaceJsPapunikaUrls : undefined);
    }
}

await Deno.writeFile(path.join(outdir, 'index.html'), new TextEncoder().encode($.html()));

if (shouldDownloadTiles) {
    await downloadTiles((zoom, x, y) => `https://papunika.com/map/public/tiles/overworld/${zoom}_${x}_${y}.jpg`, 5);
}

async function tryPublicFetchOrCached(url: string): Promise<void>;
async function tryPublicFetchOrCached(url: string, parse?: true): Promise<any>;
async function tryPublicFetchOrCached(url: string, parse?: true): Promise<any> {
    if (!url.startsWith(origin)) {
        throw new Error('bad url: ' + url);
    }

    const filepath = path.join(outdir, url.substring((url.startsWith(rootUrl) ? rootUrl : origin).length));
    const existing = canReuseCache && await findExistingCachedFile(filepath);
    if (existing && !refresh) {
        console.log('reusing cached file', filepath);
        if (parse) {
            return JSON.parse(new TextDecoder().decode(await Deno.readFile(filepath)));
        }

        return;
    }

    let i = 0;
    while (true) {
        try {
            const res = await fetch(url);
            if (res.status === 404) {
                console.warn('url not found:', url);
                return;
            }
            if (res.status !== 200) {
                throw new Error('bad status code: ' + res.status);
            }

            console.warn('fetched and cached url:', url);
            const buf = await res.arrayBuffer();
            await Deno.mkdir(path.dirname(filepath), { recursive: true });
            await Deno.writeFile(filepath, new Uint8Array(buf));

            if (parse) {
                return JSON.parse(new TextDecoder().decode(buf));
            }

            return;
        } catch (err) {
            console.error('failed to cache ' + url + ':', err);
            if (existing) {
                console.log('reusing cached file', existing);
                if (parse) {
                    return JSON.parse(new TextDecoder().decode(await Deno.readFile(filepath)));
                }
        
                return;
            }

            const time = backoff(i++);
            console.log(`retrying in ${time}ms`);
            await sleep(time);
            continue;
        }
    }
}

if (shouldDownloadAssets) {
    await Promise.all(
        assets.map((asset) => tryPublicFetchOrCached(`${rootUrl}assets/${asset}.png`)),
    )
}

const { zones } = (await tryPublicFetchOrCached(world, true));
if (shouldDownloadZones) {
    await Promise.all(
        [
            ...(
                await Promise.all(
                    [
                        tryPublicFetchOrCached(`https://papunika.com/map/data/zones/us/00000.json`, true),
                        ...zones.map(({ id }: any) => tryPublicFetchOrCached(`https://papunika.com/map/data/zones/us/${id}.json`, true)),
                    ],
                )
            ).flatMap(
                ({ markers }: any) => markers.flatMap(
                    ({ data }: any) => data.flatMap(
                        ({ popupMedia, rapportId }: any) => [
                            popupMedia && !popupMedia.startsWith('http') && tryPublicFetchOrCached(rootUrl + popupMedia),
                            rapportId && tryPublicFetchOrCached(`https://papunika.com/assets/Rapport/rapport_npc_${rapportId}.png`),
                        ],
                    ),
                ),
            ),
            ...zones.flatMap(({ id, markerType }: any) => [
                shouldDownloadZoneIcons && markerType === 1 && tryPublicFetchOrCached(`https://papunika.com/map/assets/zones/${id}.png`),
                (markerType === 2 || markerType === 3) && tryPublicFetchOrCached(`https://papunika.com/assets/Island/island_${id}.png`),
            ]),
        ],
    );
}

async function downloadTiles(url: (zoom: number, x: number, y: number) => string, maxZoom: number): Promise<void> {
    await Promise.all(
        Array.from(
            { length: maxZoom },
            (_, zoom) => Array.from(
                { length: Math.pow(2, zoom) },
                (_, x) => Array.from(
                    { length: Math.pow(2, zoom) },
                    (_, y) => tryPublicFetchOrCached(url(zoom, x, y))
                ),
            ),
        ).flat(3),
    )
}
