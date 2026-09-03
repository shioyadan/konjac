"use strict";

import {PDF_Node, PDF_NodeType, bulletListItemText} from "./extractor";

export type TranslationBlockType =
    "title" | "author" | "affiliation" | "heading" | "text" | "figure-caption";

export interface TranslationBlock {
    id: string;
    type: TranslationBlockType;
    source: string;
    translation: string;
}

export interface TranslationDocument {
    format: "konjac-translation";
    version: 1;
    source: {
        name: string;
        fingerprint: string;
    };
    sourceLanguage: "en";
    targetLanguage: "ja";
    instructions: string;
    blocks: TranslationBlock[];
}

export interface TranslationBlockEntry {
    nodeIndex: number;
    block: TranslationBlock;
}

function translationBlockType(node: PDF_Node): TranslationBlockType | null {
    switch (node.type) {
        case PDF_NodeType.TITLE:
            return "title";
        case PDF_NodeType.AUTHOR:
            return "author";
        case PDF_NodeType.AFFILIATION:
            return "affiliation";
        case PDF_NodeType.HEADING:
            return "heading";
        case PDF_NodeType.CAPTION:
        case PDF_NodeType.FIGURE:
            return "figure-caption";
        case PDF_NodeType.TEXT:
            return "text";
        default:
            return null;
    }
}

export function translationBlockEntries(
    nodes: PDF_Node[],
    translationForNode: (node: PDF_Node, index: number) => string = () => ""
) {
    let entries: TranslationBlockEntry[] = [];
    for (let [nodeIndex, node] of nodes.entries()) {
        let type = translationBlockType(node);
        let source = bulletListItemText(node) ?? node.str;
        if (!type || source == "") {
            continue;
        }
        entries.push({
            nodeIndex,
            block: {
                id: `block-${String(nodeIndex + 1).padStart(4, "0")}`,
                type,
                source,
                translation: translationForNode(node, nodeIndex)
            }
        });
    }
    return entries;
}

export function createTranslationDocument(
    sourceName: string,
    fingerprint: string,
    nodes: PDF_Node[],
    translationForNode?: (node: PDF_Node, index: number) => string
): TranslationDocument {
    return {
        format: "konjac-translation",
        version: 1,
        source: {name: sourceName, fingerprint},
        sourceLanguage: "en",
        targetLanguage: "ja",
        instructions: "Edit only blocks[].translation. Preserve every id, type, source, and all other fields exactly.",
        blocks: translationBlockEntries(nodes, translationForNode).map((entry) => entry.block)
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value == "object" && !Array.isArray(value);
}

export function parseTranslationDocument(contents: string): TranslationDocument {
    let value: unknown = JSON.parse(contents);
    if (!isRecord(value) || value.format != "konjac-translation" || value.version != 1) {
        throw new Error("This is not a Konjac translation JSON v1 file.");
    }
    if (
        !isRecord(value.source) ||
        typeof value.source.name != "string" ||
        typeof value.source.fingerprint != "string" ||
        value.sourceLanguage != "en" ||
        value.targetLanguage != "ja" ||
        typeof value.instructions != "string" ||
        !Array.isArray(value.blocks)
    ) {
        throw new Error("The translation JSON header is invalid.");
    }
    for (let [index, block] of value.blocks.entries()) {
        if (
            !isRecord(block) ||
            typeof block.id != "string" ||
            typeof block.type != "string" ||
            typeof block.source != "string" ||
            typeof block.translation != "string"
        ) {
            throw new Error(`Translation block ${index + 1} is invalid.`);
        }
    }
    return value as unknown as TranslationDocument;
}

export function matchTranslationDocument(document: TranslationDocument, fingerprint: string, nodes: PDF_Node[]) {
    if (fingerprint != "" && document.source.fingerprint != fingerprint) {
        throw new Error("This translation JSON belongs to a different PDF.");
    }

    let expectedEntries = translationBlockEntries(nodes);
    if (document.blocks.length != expectedEntries.length) {
        throw new Error(
            `The PDF has ${expectedEntries.length} translatable blocks, but the JSON has ${document.blocks.length}.`
        );
    }

    let importedById = new Map<string, TranslationBlock>();
    for (let block of document.blocks) {
        if (importedById.has(block.id)) {
            throw new Error(`Duplicate translation block: ${block.id}.`);
        }
        importedById.set(block.id, block);
    }

    return expectedEntries.map((entry) => {
        let imported = importedById.get(entry.block.id);
        if (!imported) {
            throw new Error(`Missing translation block: ${entry.block.id}.`);
        }
        if (imported.type != entry.block.type) {
            throw new Error(`The type of ${entry.block.id} was changed.`);
        }
        if (imported.source != entry.block.source) {
            throw new Error(`The source text of ${entry.block.id} was changed.`);
        }
        return {nodeIndex: entry.nodeIndex, block: imported};
    });
}
