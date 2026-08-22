# Reference packs

Drop Photoshop `.abr` files here to study them:

```bash
npm run brush -- inspect refs/SomePack.abr --json
npm run brush -- inspect refs/SomePack.abr --render out/ref.png
npm run brush -- compare brushes/mine.json --ref refs/SomePack.abr#"Rough Bristle"
```

`.abr` files in this directory are **gitignored**. Most brush packs are
licensed work and a repository is not a good place to redistribute them.
Check the licence before shipping a tip bitmap borrowed from one — the tip
is the part someone actually drew.
