// tslint:disable:whitespace
import * as queue from "async/queue";
import clone = require("lodash/clone");
import { core, MergeTree } from "../client-api";
import { IIntelligentService } from "../intelligence";
import { SharedString } from "../shared-string";

interface ISpellQuery {
    // Request text to spellcheck.
    text: string;

    // Reference sequence number.
    rsn: number;

    // Start position.
    start: number;

    // End position
    end: number;
}

interface IPgMarker {

    tile: MergeTree.Marker;

    pos: number;
}

function compareProxStrings(a: MergeTree.ProxString<number>, b: MergeTree.ProxString<number>) {
    const ascore = ((a.invDistance * 200) * a.val) + a.val;
    const bscore = ((b.invDistance * 200) * b.val) + b.val;
    return bscore - ascore;
}

class Speller {
    private static altMax = 7;
    private static spellerParagraphs = 10000;
    private static idleTimeMS = 500;
    private currentIdleTime: number = 0;
    private pendingSpellChecks: MergeTree.IMergeTreeOp[] = [];
    private pendingParagraphs: IPgMarker[] = new Array<IPgMarker>();
    private offsetMap: { [start: number]: number } = {};
    private verbose = false;
    private serviceCounter: number = 0;
    private initialQueue: any;
    private typingQueue: any;

    constructor(
        public sharedString: SharedString,
        private dict: MergeTree.TST<number>,
        private intelligence: IIntelligentService) {
        this.initializeSpellerQueue();
    }

    public initialSpellCheck() {
        const spellParagraph = (startPG: number, endPG: number, text: string) => {
            const re = /\b\w+\b/g;
            let result: RegExpExecArray;
            this.initSpellerService(this.intelligence, text, startPG);
            do {
                result = re.exec(text);
                if (result) {
                    const candidate = result[0];
                    if (this.spellingError(candidate.toLocaleLowerCase())) {
                        const start = result.index;
                        const end = re.lastIndex;
                        const textErrorInfo = this.makeTextErrorInfo(candidate);
                        if (this.verbose) {
                            console.log(`spell (${startPG + start}, ${startPG + end}): ${textErrorInfo.text}`);
                        }
                        this.sharedString.annotateRange({ textError: textErrorInfo }, startPG + start, startPG + end);
                    }
                }
            } while (result);
        };
        let prevPG: MergeTree.Marker;
        let startPGPos = 0;
        let pgText = "";
        let endMarkerFound = false;
        const mergeTree = this.sharedString.client.mergeTree;
        function gatherPG(segment: MergeTree.Segment, segpos: number) {
            switch (segment.getType()) {
                case MergeTree.SegmentType.Marker:
                    const marker = segment as MergeTree.Marker;
                    if (mergeTree.localNetLength(segment)) {
                        if (marker.hasTileLabel("pg")) {
                            if (prevPG) {
                                // TODO: send paragraph to service
                                spellParagraph(startPGPos, segpos, pgText);
                                endMarkerFound = true;
                            }
                            startPGPos = segpos + mergeTree.localNetLength(segment);
                            prevPG = marker;
                            pgText = "";
                            if (endMarkerFound) {
                                return false;
                            }
                        } else {
                            for (let i = 0; i < mergeTree.localNetLength(segment); i++) {
                                pgText += " ";
                            }
                        }
                    }
                    break;
                case MergeTree.SegmentType.Text:
                    const textSegment = segment as MergeTree.TextSegment;
                    if (mergeTree.localNetLength(textSegment)) {
                        pgText += textSegment.text;
                    }
                    break;
                default:
                    throw new Error("Unknown SegmentType");
            }
            return true;
        }

        do {
            endMarkerFound = false;
            this.sharedString.client.mergeTree.mapRange({ leaf: gatherPG }, MergeTree.UniversalSequenceNumber,
                this.sharedString.client.getClientId(), undefined, startPGPos);
        } while (endMarkerFound);

        if (prevPG) {
            // TODO: send paragraph to service
            spellParagraph(startPGPos, startPGPos + pgText.length, pgText);
        }

        this.setEvents(this.intelligence);
    }

    private initializeSpellerQueue() {
        this.initialQueue = queue((task: ISpellQuery, callback) => {
            const resultP = this.intelligence.run(task);
            resultP.then((result) => {
                const spellErrors = this.checkSpelling(task.rsn, task.text, task.start, result);
                console.log(spellErrors.rsn);
                callback();
            }, (error) => {
                callback();
            });
        }, 1);
        this.typingQueue = queue((task: ISpellQuery, callback) => {
            callback();
        }, 1);
    }
    private spellingError(word: string) {
        if (/\b\d+\b/.test(word)) {
            return false;
        } else {
            return !this.dict.contains(word);
        }
    }
    // TODO: use delayed spell check on each modified paragraph
    private spellOp(delta: MergeTree.IMergeTreeOp, intelligence: IIntelligentService) {
        // let setPending = () => {
        //     if (this.pendingWordCheckTimer) {
        //         clearTimeout(this.pendingWordCheckTimer);
        //     }
        //     this.pendingWordCheckTimer = setTimeout(() => {
        //         this.checkPending(intelligence);
        //     }, 300);
        // }
        if (delta.type === MergeTree.MergeTreeDeltaType.INSERT) {
            //            this.pendingCheckInfo = { pos: delta.pos1 };
            //            setPending();
            this.currentWordSpellCheck(intelligence, delta.pos1);
        } else if (delta.type === MergeTree.MergeTreeDeltaType.REMOVE) {
            //            this.pendingCheckInfo = { pos: delta.pos1, rev: true };
            //            setPending();
            this.currentWordSpellCheck(intelligence, delta.pos1, true);
        } else if (delta.type === MergeTree.MergeTreeDeltaType.GROUP) {
            for (const groupOp of delta.ops) {
                this.spellOp(groupOp, intelligence);
            }
        }
    }

    private enqueueParagraph(delta: MergeTree.IMergeTreeOp) {
        if (delta.type === MergeTree.MergeTreeDeltaType.INSERT ||
            delta.type === MergeTree.MergeTreeDeltaType.REMOVE) {
            const pgRef = this.sharedString.client.mergeTree.findTile(delta.pos1,
                this.sharedString.client.getClientId(), "pg");
            let pgMarker: IPgMarker;
            if (!pgRef) {
                pgMarker = { tile: undefined, pos: 0 };
            } else {
                pgMarker = { tile: pgRef.tile as MergeTree.Marker, pos: pgRef.pos };
            }
            this.pendingParagraphs.push(pgMarker);
        } else if (delta.type === MergeTree.MergeTreeDeltaType.GROUP) {
            for (const groupOp of delta.ops) {
                this.enqueueParagraph(groupOp);
            }
        }
    }

    private setEvents(intelligence: IIntelligentService) {
        const idleCheckerMS = Speller.idleTimeMS / 5;
        setInterval(() => {
            this.currentIdleTime += idleCheckerMS;
            if (this.currentIdleTime >= Speller.idleTimeMS) {
                this.runSpellOp(intelligence);
                this.currentIdleTime = 0;
            }
        }, idleCheckerMS);
        this.sharedString.on("op", (msg: core.ISequencedObjectMessage) => {
            if (msg && msg.contents) {
                const delta = msg.contents as MergeTree.IMergeTreeOp;
                this.pendingSpellChecks.push(delta);
                this.enqueueParagraph(delta);
                this.currentIdleTime = 0;
            }
        });
    }

    private runSpellOp(intelligence: IIntelligentService) {
        if (this.pendingSpellChecks.length > 0) {
            const pendingChecks = clone(this.pendingSpellChecks);
            this.pendingSpellChecks = [];
            for (const delta of pendingChecks) {
                this.spellOp(delta, intelligence);
            }
        }
        if (this.pendingParagraphs.length > 0) {
            for (const pg of this.pendingParagraphs) {
                let offset = 0;
                if (pg.tile) {
                    offset = this.sharedString.client.mergeTree.getOffset(pg.tile, MergeTree.UniversalSequenceNumber,
                        this.sharedString.client.getClientId());
                }
                const endMarkerPos = this.sharedString.client.mergeTree.findTile(offset,
                    this.sharedString.client.getClientId(), "pg", false);
                let endPos: number;
                if (endMarkerPos) {
                    endPos = endMarkerPos.pos;
                } else {
                    endPos = this.sharedString.client.mergeTree.getLength(MergeTree.UniversalSequenceNumber,
                        this.sharedString.client.getClientId());
                }
                this.offsetMap[offset] = endPos;
            }
            for (const start of Object.keys(this.offsetMap)) {
                const queryString = this.sharedString.client.mergeTree.getText(MergeTree.UniversalSequenceNumber,
                    this.sharedString.client.getClientId(), "", Number(start), this.offsetMap[start]);
                this.enqueNewQuery(intelligence, queryString, Number(start));
            }
            this.offsetMap = {};
            this.pendingParagraphs = [];
        }
    }

    private makeTextErrorInfo(candidate: string) {
        const alternates = this.dict.neighbors(candidate, 2).sort(compareProxStrings);
        if (alternates.length > Speller.altMax) {
            alternates.length = Speller.altMax;
        }
        return {
            alternates,
            text: candidate,
        };
    }

    private currentWordSpellCheck(intelligence: IIntelligentService, pos: number, rev = false) {
        let words = "";
        let fwdWords = "";
        let sentence = "";
        let fwdSentence = "";
        let wordsFound = false;
        const mergeTree = this.sharedString.client.mergeTree;

        const gatherReverse = (segment: MergeTree.Segment) => {
            switch (segment.getType()) {
                case MergeTree.SegmentType.Marker:
                    if (!wordsFound) {
                        words = " " + words;
                    }
                    sentence = " " + sentence;
                    const marker = segment as MergeTree.Marker;
                    if (marker.hasTileLabel("pg")) {
                        return false;
                    }
                    break;
                case MergeTree.SegmentType.Text:
                    const textSegment = segment as MergeTree.TextSegment;
                    if (mergeTree.localNetLength(textSegment)) {
                        if (!wordsFound) {
                            words = textSegment.text + words;
                        }
                        sentence = textSegment.text + sentence;
                    }
                    break;
                // TODO: component
                default:
                    throw new Error("Unknown SegmentType");
            }
            // console.log(`rev: -${text}-`);
            if (/\s+\w+/.test(words)) {
                wordsFound = true;
            }
            if (/[\?\.\!]\s*\w+/.test(sentence)) {
                return false;
            }
            return true;
        };

        const gatherForward = (segment: MergeTree.Segment) => {
            switch (segment.getType()) {
                case MergeTree.SegmentType.Marker:
                    if (!wordsFound) {
                        fwdWords = fwdWords + " ";
                    }
                    fwdSentence = fwdSentence + " ";
                    const marker = segment as MergeTree.Marker;
                    if (marker.hasTileLabel("pg")) {
                        return false;
                    }
                    break;
                case MergeTree.SegmentType.Text:
                    const textSegment = segment as MergeTree.TextSegment;
                    if (mergeTree.localNetLength(textSegment)) {
                        if (!wordsFound) {
                            fwdWords = fwdWords + textSegment.text;
                        }
                        fwdSentence = fwdSentence + textSegment.text;
                    }
                    break;
                // TODO: component
                default:
                    throw new Error("Unknown SegmentType");
            }
            if (/\w+\s+/.test(fwdWords)) {
                wordsFound = true;
            }
            if (/\w+\s*[\.\?\!]/.test(fwdSentence)) {
                return false;
            }
            return true;
        };

        const segoff = this.sharedString.client.mergeTree.getContainingSegment(pos,
            MergeTree.UniversalSequenceNumber, this.sharedString.client.getClientId());
        if (segoff && segoff.segment) {
            if (segoff.offset !== 0) {
                console.log("expected pos only at segment boundary");
            }
            // assumes op has made pos a segment boundary
            this.sharedString.client.mergeTree.leftExcursion(segoff.segment, gatherReverse);
            const startPos = pos - words.length;
            const sentenceStartPos = pos - sentence.length;

            if (segoff.segment) {
                wordsFound = false;
                if (gatherForward(segoff.segment)) {
                    this.sharedString.client.mergeTree.rightExcursion(segoff.segment, gatherForward);
                }
                words = words + fwdWords;
                sentence = sentence + fwdSentence;
                if (this.verbose) {
                    // tslint:disable-next-line:max-line-length
                    console.log(`found sentence ${sentence} (start ${sentenceStartPos}, end ${sentenceStartPos + sentence.length}) around change`);
                }
                // TODO: send this sentence to service for analysis
                const re = /\b\w+\b/g;
                let result: RegExpExecArray;
                do {
                    result = re.exec(words);
                    if (result) {
                        const start = result.index + startPos;
                        const end = re.lastIndex + startPos;
                        const candidate = result[0];
                        if (this.spellingError(candidate.toLocaleLowerCase())) {
                            const textErrorInfo = this.makeTextErrorInfo(candidate);
                            if (this.verbose) {
                                console.log(`respell (${start}, ${end}): ${textErrorInfo.text}`);
                                let buf = "alternates: ";
                                for (const alt of textErrorInfo.alternates) {
                                    buf += ` ${alt.text}:${alt.invDistance}:${alt.val}`;
                                }
                                console.log(buf);
                            }
                            this.sharedString.annotateRange({ textError: textErrorInfo }, start, end);
                        } else {
                            if (this.verbose) {
                                // tslint:disable:max-line-length
                                console.log(`spell ok (${start}, ${end}): ${words.substring(result.index, re.lastIndex)}`);
                            }
                            this.sharedString.annotateRange({ textError: null }, start, end);
                        }
                    }
                }
                while (result);
            }
        }
    }

    private initSpellerService(intelligence: IIntelligentService, queryString: string, startPos: number) {
        if (this.serviceCounter < Speller.spellerParagraphs) {
            if (queryString.length > 0) {
                this.initialQueue.push({
                    end: startPos + queryString.length,
                    rsn: this.sharedString.sequenceNumber,
                    start: startPos,
                    text: queryString,
                });
                ++this.serviceCounter;
            }
        }
    }

    private enqueNewQuery(intelligence: IIntelligentService, queryString: string, startPos: number) {
        if (queryString.length > 0) {
            this.typingQueue.push({
                end: startPos + queryString.length,
                rsn: this.sharedString.sequenceNumber,
                start: startPos,
                text: queryString,
            });
        }
    }

    private checkSpelling(rsn: number, original: string, startPos: number, result: any) {
        const endPos = startPos + original.length;
        const annotationRanges = [];

        // No critiques from spellchecker service. Clear the whole paragraph.
        if (result.spellcheckerResult.answer === null) {
            annotationRanges.push({ textError: null, globalStartOffset: startPos, globalEndOffset: endPos });
            return { rsn, annotations: annotationRanges };
        }
        const answer = result.spellcheckerResult.answer;
        if (answer.Critiques.length === 0) {
            annotationRanges.push({ textError: null, globalStartOffset: startPos, globalEndOffset: endPos });
            return { rsn, annotations: annotationRanges };
        }

        // Go through each critique and create annotation ranges.
        let runningStart = startPos;
        const critiques = answer.Critiques;
        for (const critique of critiques) {
            const localStartOffset = critique.Start;
            const localEndOffset = localStartOffset + critique.Length;
            const origWord = original.substring(localStartOffset, localEndOffset);
            const globalStartOffset = startPos + localStartOffset;
            const globalEndOffset = startPos + localEndOffset;
            const altSpellings = [];

            // Correctly spelled range. Send null and update runningStart.
            if (runningStart < globalStartOffset) {
                annotationRanges.push({
                    globalEndOffset: globalStartOffset,
                    globalStartOffset: runningStart,
                    textError: null,
                });
            }
            runningStart = globalEndOffset;

            // Spelling error but no suggestions found. Continue to next critique.
            if (critique.Suggestions.length === 0 || critique.Suggestions[0].Text === "No suggestions") {
                if (critique.CategoryTitle === "Grammar") {
                    annotationRanges.push({
                        globalEndOffset,
                        globalStartOffset,
                        textError: { text: origWord, alternates: altSpellings, color: "paulgreen", explanation: null },
                    });
                } else if (critique.CategoryTitle === "Spelling") {
                    annotationRanges.push({
                        globalEndOffset,
                        globalStartOffset,
                        textError: { text: origWord, alternates: altSpellings, color: "paul", explanation: null },
                    });
                } else {
                    annotationRanges.push({
                        globalEndOffset,
                        globalStartOffset,
                        textError: { text: origWord, alternates: altSpellings, color: "paulgolden", explanation: null },
                    });
                }
                continue;
            }
            // Suggestions found. Create annotation ranges.
            for (let i = 0; i < Math.min(Speller.altMax, critique.Suggestions.length); ++i) {
                altSpellings.push({ text: critique.Suggestions[i].Text, invDistance: i, val: i });
            }
            if (critique.CategoryTitle === "Grammar") {
                annotationRanges.push({
                    globalEndOffset,
                    globalStartOffset,
                    textError: {
                        alternates: altSpellings,
                        color: "paulgreen",
                        explanation: critique.Explanation,
                        text: origWord,
                    },
                });
            } else if (critique.CategoryTitle === "Spelling") {
                annotationRanges.push({
                    globalEndOffset,
                    globalStartOffset,
                    textError: { text: origWord, alternates: altSpellings, color: "paul", explanation: null },
                });
            } else {
                annotationRanges.push({
                    globalEndOffset,
                    globalStartOffset,
                    textError: {
                        alternates: altSpellings,
                        color: "paulgolden",
                        explanation: critique.Explanation,
                        text: origWord,
                    },
                });
            }
        }
        // No more critiques. Send null for rest of the text.
        if (runningStart < endPos) {
            annotationRanges.push({ textError: null, globalStartOffset: runningStart, globalEndOffset: endPos });
        }
        return { rsn, annotations: annotationRanges };
    }
}

export class Spellcheker {
    constructor(
        private root: SharedString,
        private dict: MergeTree.TST<number>,
        private intelligence: IIntelligentService) {
    }

    public run() {
        this.root.loaded.then(() => {
            const theSpeller = new Speller(this.root, this.dict, this.intelligence);
            theSpeller.initialSpellCheck();
        });
    }
}
