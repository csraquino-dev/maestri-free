'use strict';
// Note stacks ("fichário"): several notes filed into one node with tabs. The member notes stay in the document
// (so every note, file and connection keeps working) but are hidden on the canvas; the stack node owns the order,
// the front page and a few options. A connection to a stack is a connection to every page.
const fs = require('fs');
const persistence = require('./persistence');
const { frameRect, rectFrame } = require('./workspaces');

const isNote = (n) => !!(n && n.content.stickyNote);
const isStack = (n) => !!(n && n.content.noteStack);
const data = (n) => n.content.noteStack._0;

function createStacks(workspaces) {
  const memberIds = (doc) => {
    const s = new Set();
    for (const n of doc.payload.nodes) if (isStack(n)) data(n).memberNodeIds.forEach((id) => s.add(id));
    return s;
  };
  const stackOf = (doc, noteId) =>
    doc.payload.nodes.find((n) => isStack(n) && data(n).memberNodeIds.includes(noteId)) || null;
  const get = (doc, id) => {
    const n = workspaces.findNode(doc, id);
    if (!isStack(n)) throw new Error('not a note stack');
    return n;
  };

  // Every page is reachable from everything the stack is connected to.
  function syncConnections(doc, stack) {
    const pl = doc.payload;
    const members = data(stack).memberNodeIds;
    const terminals = new Set();
    for (const c of pl.noteConnections) if (members.includes(c.noteNodeId)) terminals.add(c.terminalId);
    for (const t of terminals) for (const m of members) workspaces.connect(doc, t, m);
  }

  function uniqueName(doc, base) {
    const taken = new Set(doc.payload.nodes.filter(isNote).map((n) => workspaces.noteNameOf(n).toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 500; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
    return `${base} ${Date.now()}`;
  }

  return {
    memberIds,
    stackOf,

    create(doc, noteIds, name) {
      const already = memberIds(doc);
      const ids = [...new Set(noteIds)].filter((id) => isNote(workspaces.findNode(doc, id)) && !already.has(id));
      if (ids.length < 2) throw new Error('select at least two notes that are not already in a stack');
      const first = workspaces.findNode(doc, ids[0]);
      const rect = frameRect(first.frame);
      const node = workspaces.makeNode(
        doc,
        {
          __content: {
            noteStack: {
              _0: {
                name: name || 'Fichário',
                hasCustomName: !!name,
                frontNoteId: ids[0],
                memberNodeIds: ids,
                uniformColor: false,
                engaged: false,
              },
            },
          },
        },
        rect,
        first.floorId || null,
      );
      doc.payload.nodes.push(node);
      for (const id of ids) workspaces.findNode(doc, id).frame = rectFrame(rect);
      syncConnections(doc, node);
      return node;
    },

    addNotes(doc, stackId, noteIds) {
      const stack = get(doc, stackId);
      const already = memberIds(doc);
      let n = 0;
      for (const id of noteIds) {
        if (already.has(id) || !isNote(workspaces.findNode(doc, id))) continue;
        data(stack).memberNodeIds.push(id);
        already.add(id); // the same note listed twice is filed once
        workspaces.findNode(doc, id).frame = rectFrame(frameRect(stack.frame));
        n++;
      }
      if (n) syncConnections(doc, stack);
      return n;
    },

    addPage(doc, stackId) {
      const stack = get(doc, stackId);
      const note = workspaces.addNote(doc, {
        name: uniqueName(doc, 'Página'),
        content: '',
        rect: frameRect(stack.frame),
        floorId: stack.floorId || null,
      });
      data(stack).memberNodeIds.push(note.id);
      data(stack).frontNoteId = note.id;
      syncConnections(doc, stack);
      return note;
    },

    setFront(doc, stackId, noteId) {
      const stack = get(doc, stackId);
      if (!data(stack).memberNodeIds.includes(noteId)) throw new Error('that note is not in the stack');
      data(stack).frontNoteId = noteId;
    },

    moveMember(doc, stackId, noteId, beforeId) {
      const d = data(get(doc, stackId));
      const i = d.memberNodeIds.indexOf(noteId);
      if (i < 0) throw new Error('that note is not in the stack');
      d.memberNodeIds.splice(i, 1);
      const j = beforeId ? d.memberNodeIds.indexOf(beforeId) : -1;
      d.memberNodeIds.splice(j < 0 ? d.memberNodeIds.length : j, 0, noteId);
    },

    rename(doc, stackId, name) {
      const d = data(get(doc, stackId));
      d.name = String(name).trim() || d.name;
      d.hasCustomName = true;
    },

    // Take one page out onto the canvas, next to the stack. A stack of one is dissolved.
    spill(doc, stackId, noteId) {
      const stack = get(doc, stackId);
      const d = data(stack);
      const i = d.memberNodeIds.indexOf(noteId);
      if (i < 0) throw new Error('that note is not in the stack');
      d.memberNodeIds.splice(i, 1);
      if (d.frontNoteId === noteId) d.frontNoteId = d.memberNodeIds[0] || null;
      const note = workspaces.findNode(doc, noteId);
      const r = frameRect(stack.frame);
      note.frame = rectFrame(workspaces.freeRect(doc, r.w, r.h, r, stack.floorId || null));
      if (d.memberNodeIds.length < 2) this.unstackAll(doc, stackId);
      return note;
    },

    unstackAll(doc, stackId) {
      const stack = get(doc, stackId);
      const r = frameRect(stack.frame);
      data(stack).memberNodeIds.forEach((id, i) => {
        const n = workspaces.findNode(doc, id);
        if (n) n.frame = rectFrame({ x: r.x + i * 36, y: r.y + i * 36, w: r.w, h: r.h });
      });
      doc.payload.nodes = doc.payload.nodes.filter((n) => n.id !== stackId);
    },

    toggleUniformColor(doc, stackId) {
      const stack = get(doc, stackId);
      const d = data(stack);
      d.uniformColor = !d.uniformColor;
      if (d.uniformColor) {
        const front = workspaces.findNode(doc, d.frontNoteId || d.memberNodeIds[0]);
        const color = front && front.content.stickyNote._0.color;
        for (const id of d.memberNodeIds) {
          const n = workspaces.findNode(doc, id);
          if (n && color) n.content.stickyNote._0.color = color;
        }
      }
      return d.uniformColor;
    },

    // keepNotes=true: the notes go back to the canvas; false: notes (and their files) are deleted too.
    remove(doc, stackId, { keepNotes = true } = {}) {
      const stack = get(doc, stackId);
      if (keepNotes) return this.unstackAll(doc, stackId);
      for (const id of [...data(stack).memberNodeIds]) {
        const n = workspaces.findNode(doc, id);
        if (n && isNote(n)) {
          try {
            fs.rmSync(workspaces.notePath(doc, n), { force: true });
          } catch {
            /* already gone */
          }
        }
        workspaces.removeNode(doc, id);
      }
      workspaces.removeNode(doc, stackId);
      return undefined;
    },
  };
}

module.exports = { createStacks, isStack, isNote, persistence };
