## papunika-map-mirror

This program downloads sources and assets from the [papunika lost ark map](https://papunika.com/map/) necessary for a local instance for the purposes of:
 - archival
 - improved performance page load
 - relieving stress on the official page

### Usage

```
deno run --allow-net --allow-write src/main.ts
```

This will create a "mirror" folder which contains a static snapshot of the map. This folder may be served with any static website server software.

Some good options are:

```
caddy file-server
```

```
npx http-server
```

```
python3 -m http.server
```
