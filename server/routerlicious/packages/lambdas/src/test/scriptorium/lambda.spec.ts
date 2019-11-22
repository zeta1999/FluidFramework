/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IPartitionLambda } from "@microsoft/fluid-server-services-core";
import { KafkaMessageFactory, MessageFactory, TestCollection, TestContext } from "@microsoft/fluid-server-test-utils";
import * as assert from "assert";
import { ScriptoriumLambda } from "../../scriptorium/lambda";

describe("Routerlicious", () => {
    describe("Scriptorium", () => {
        describe("Lambda", () => {
            const testTenantId = "test";
            const testDocumentId = "test";
            const testClientId = "test";

            let testCollection: TestCollection;
            let testContext: TestContext;
            let messageFactory: MessageFactory;
            let kafkaMessageFactory: KafkaMessageFactory;
            let lambda: IPartitionLambda;

            beforeEach(() => {
                messageFactory = new MessageFactory(testDocumentId, testClientId, testTenantId);
                kafkaMessageFactory = new KafkaMessageFactory();

                testCollection = new TestCollection([]);
                testContext = new TestContext();
                lambda = new ScriptoriumLambda(testCollection, undefined, testContext);

            });

            describe(".handler()", () => {
                it("Should store incoming messages to database", async () => {
                    const numMessages = 10;
                    for (let i = 0; i < numMessages; i++) {
                        const message = messageFactory.createSequencedOperation();
                        lambda.handler(kafkaMessageFactory.sequenceMessage(message, testDocumentId));
                    }
                    await testContext.waitForOffset(kafkaMessageFactory.getHeadOffset(testDocumentId));

                    assert.equal(numMessages, testCollection.collection.length);
                });
            });
        });
    });
});