import * as assert from "assert";
import { RangeTracker } from "../../shared";

describe("Routerlicious", () => {
    describe("Shared", () => {
        describe("RangeTracker", () => {
            let rangeTracker: RangeTracker;

            beforeEach(() => {
                rangeTracker = new RangeTracker(0, 0);
            });

            describe(".base", () => {
                it("Should match value provided to constructor", () => {
                    assert.equal(rangeTracker.base, 0);
                });
            });

            describe(".add()", () => {
                it("Should be able to add a single range", () => {
                    const primary = 5;
                    const secondary = 10;

                    rangeTracker.add(primary, secondary);
                    assert.equal(rangeTracker.primaryHead, primary);
                    assert.equal(rangeTracker.secondaryHead, secondary);
                    assert.equal(rangeTracker.get(primary - 1), 0);
                    assert.equal(rangeTracker.get(primary), secondary);
                    assert.equal(rangeTracker.get(primary + 1), secondary);
                });

                it("Should be able to add a concurrent range", () => {
                    const start = 5;
                    const stop = 10;
                    for (let i = start; i <= stop; i++) {
                        rangeTracker.add(i, i);
                    }

                    assert.equal(rangeTracker.primaryHead, stop);
                    assert.equal(rangeTracker.secondaryHead, stop);

                    for (let i = start; i <= stop; i++) {
                        assert.equal(rangeTracker.get(i), i);
                    }
                });

                it("Should be able to add a disjoint range", () => {
                    rangeTracker.add(5, 10);
                    rangeTracker.add(7, 13);
                    assert.equal(rangeTracker.get(5), 10);
                    assert.equal(rangeTracker.get(6), 10);
                    assert.equal(rangeTracker.get(7), 13);
                    assert.equal(rangeTracker.get(8), 13);
                });

                it("Should be able to update the primary head mapping", () => {
                    rangeTracker.add(4, 5);
                    assert.equal(rangeTracker.get(4), 5);
                    rangeTracker.add(4, 7);
                    assert.equal(rangeTracker.get(4), 7);
                });

                it("Should be able to update the primary head mapping when tracking a concurrent range", () => {
                    for (let i = 5; i <= 10; i++) {
                        rangeTracker.add(i, i);
                    }
                    assert.equal(rangeTracker.get(10), 10);
                    rangeTracker.add(10, 20);
                    assert.equal(rangeTracker.get(10), 20);
                });

                it("Should be able to add new primary values that reference the secondary head", () => {
                    rangeTracker.add(5, 10);
                    rangeTracker.add(8, 10);
                    assert.equal(rangeTracker.get(5), 10);
                    assert.equal(rangeTracker.get(8), 10);
                    assert.equal(rangeTracker.get(10), 10);
                });
            });

            describe(".get", () => {
                it("Should return the corresponding secondary value for a primary value", () => {
                    rangeTracker.add(5, 10);
                    rangeTracker.add(10, 20);
                    assert.equal(rangeTracker.get(0), 0);
                    assert.equal(rangeTracker.get(3), 0);
                    assert.equal(rangeTracker.get(5), 10);
                    assert.equal(rangeTracker.get(8), 10);
                    assert.equal(rangeTracker.get(10), 20);
                    assert.equal(rangeTracker.get(15), 20);
                });
            });

            describe(".updateBase", () => {
                it("Should be able to update base to between a range", () => {
                    rangeTracker.add(5, 10);
                    rangeTracker.updateBase(7);
                    assert.equal(7, rangeTracker.base);
                });

                it("Should be able to update base to between a concurrent range", () => {
                    rangeTracker.add(4, 2);
                    for (let i = 5; i <= 10; i++) {
                        rangeTracker.add(i, i);
                    }
                    rangeTracker.updateBase(8);
                    assert.equal(rangeTracker.base, 8);
                    for (let i = 8; i <= 10; i++) {
                        assert.equal(rangeTracker.get(i), i);
                    }
                    assert.equal(rangeTracker.get(11), 10);
                });

                it("Should be able to update to the end of a range", () => {
                    rangeTracker.add(4, 2);
                    rangeTracker.add(8, 10);
                    rangeTracker.updateBase(10);
                    assert.equal(rangeTracker.get(10), 10);
                });

                it("Should be able to update to the existing base", () => {
                    rangeTracker.add(4, 2);
                    rangeTracker.updateBase(0);
                    assert.equal(rangeTracker.get(0), 0);
                });
            });
        });
    });
});
