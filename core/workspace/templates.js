//Templates: a workspace composition described as DATA and applied through the Workspace controller (the only mutation path),
//so it is validated, undoable as ONE step, and synchronized like anything a person would have done by hand.
//
//  { title,
//    instances: [{ key, type, label?, config?, text?, place?: { of: <key>, side } }],     place.of: next to that instance's panel
//    connections: [{ from: [key, port], to: [key, port] }] }
//
//The core knows nothing about what a template says: the content (e.g. the welcome workspace) lives with the application.
export function applyTemplate(workspace, template) {
    const unknown = template.instances.filter(spec => !workspace.registry.getManifest(spec.type)).map(spec => spec.type);
    if (unknown.length) throw new Error(`Template uses components that are not registered: ${unknown.join(', ')}`);      //checked first: nothing is half-applied
    const ids = new Map();
    workspace.doc.transact(`template ${template.title ?? ''}`.trim(), () => {
        if (template.title) workspace.setTitle(template.title);
        for (const spec of template.instances) {
            const target = spec.place ? { panelId: workspace.layout.findPanelOf(ids.get(spec.place.of)), side: spec.place.side ?? 'center' } : {};
            const id = workspace.addInstance(spec.type, { config: spec.config ?? {}, label: spec.label ?? null, target, createdVia: 'template' });
            ids.set(spec.key, id);
            if (spec.text !== undefined) workspace.sharedText(id).setText(spec.text);
        }
        for (const { from, to } of template.connections ?? []) {
            workspace.bus.connect({ instance: ids.get(from[0]), port: from[1] }, { instance: ids.get(to[0]), port: to[1] }, { createdVia: 'template' });
        }
    });
    return ids;
}
