//The generic components that ship with the Agora core. Applications add their own packs next to these.
export const CORE_MANIFESTS = [
    './text/ultima-text.manifest.json',
    './notes/ultima-notes.manifest.json',
];

export async function registerCoreComponents(registry) {
    await Promise.all(CORE_MANIFESTS.map(path => registry.registerFromUrl(new URL(path, import.meta.url))));
}
