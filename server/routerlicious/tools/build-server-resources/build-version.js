/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * This script is used by the build server to compute the version number of the packages.
 * The release version number is based on what's in the lerna.json/package.json.
 * The CI will supply the build number and branch to determine the prerelease suffix if it is not a tagged build
 * 
 * Input:
 *      ./lerna.json or ./package.json - base version number to use
 *      env:VERSION_BUILDNUMBER        - monotonically increasing build number from the CI
 *      env:VERSION_BUILDBRANCH        - the build branch/tags that triggered the build 
 * Output:
 *      The computed version output to the console.
 */

const fs = require("fs");
function getFileVersion() {
    if (fs.existsSync("./lerna.json")) {
        return JSON.parse(fs.readFileSync("./lerna.json")).version;
    }
    if (fs.existsSync("./package.json")) {
        return JSON.parse(fs.readFileSync("./package.json")).version;
    }
    console.error(`ERROR: lerna.json or package.json not found`);
    process.exit(5);
}

function parseFileVersion(file_version, build_num) {
    let split = file_version.split("-");
    let release_version = split[0];
    split.shift();
    let prerelease_version = split.join("-");
    let isBackCompat = false;

    /**
     * Back compat. Version <= 0.15 (or server 0.1003) we use the build number as the patch number.
     */

    // split the prerelease out
    const r = release_version.split('.');
    if (r.length !== 3) {
        console.error(`ERROR: Invalid format for release version ${release_version}`);
        process.exit(6);
    }

    const minor = parseInt(r[1]);
    if (r[0] === "0" && (minor <= 15 || minor === 1003)) {
        isBackCompat = true;
        r[2] = parseInt(r[2]) + parseInt(build_num);
        release_version = r.join('.');
    }

    return { release_version, prerelease_version, isBackCompat };
}

/**
 * Compute the build suffix
 *
 * The suffix follows the CSemVer-CI format, see https://csemver.org/ 
 *
 * If the build is trigger by tags, no suffix is needed (those are released bits).
 * Otherwise it is a CI only build, and we add the following suffix depending on the branch
 *     PRs:               refs/pull/*                             | ci.<build_number>.dev
 *     Official branches: refs/heads/master, refs/heads/release/* | ci.<build_number>.official
 *     Manual builds:     <all others>                            | ci.<build_number>.manual
 */
function getBuildSuffix(env_build_branch, build_num, isFull) {
    // Split the branch
    const build_branch = env_build_branch.split('/');
    if (build_branch[0] !== 'refs') {
        console.error(`ERROR: Invalid branch specification ${env_build_branch}`);
        process.exit(6);
    }

    // Suffix based on branch.

    // Tag releases
    if (build_branch[1] === 'tags') {
        return "";
    }

    if (!isFull) {
        return `${build_num}`;
    }

    // PRs
    if (build_branch[1] === 'pull') {
        return `ci.${build_num}.dev`;
    }

    // master or release branches
    if (build_branch[1] === 'heads' && (build_branch[2] === 'master' || build_branch[2] === "release")) {
        return `ci.${build_num}.official`;
    }

    // Otherwise, it is manual builds
    return `ci.${build_num}.manual`;
}

function generateFullVersion(release_version, prerelease_version, build_suffix) {
    // Generate the full version string
    if (prerelease_version) {
        if (build_suffix) {
            const p = prerelease_version.split('.');
            while (p.length < 3) {
                // pad it to at least 3 entries.
                p.push("0");
            }
            return `${release_version}-${p.join(".")}.${build_suffix}`;
        }
        return `${release_version}-${prerelease_version}`;
    }

    if (build_suffix) {
        // Add "--" between the release and the suffix
        // one "-" to start he prerelease version
        // another "-" so that CI build will precede other manually named prerelease build.
        return `${release_version}--${build_suffix}`;
    }

    return release_version;
}

function getFullVersion(file_version, arg_build_num, arg_build_branch) {
    // Azure DevOp pass in the build number as $(buildNum).$(buildAttempt).
    // Get the Build number and ignore the attempt number.
    const build_num = parseInt(arg_build_num.split('.')[0]);

    const { release_version, prerelease_version, isBackCompat } = parseFileVersion(file_version, build_num);
    const build_suffix = isBackCompat ? "" : getBuildSuffix(arg_build_branch, build_num, true);
    const fullVersion = generateFullVersion(release_version, prerelease_version, build_suffix);
    return fullVersion;
}

/* A simpler CI version that append the build number at the end in the prerelease */
function generateSimpleVersion(release_version, prerelease_version, build_suffix) {
    // Generate the full version string
    if (prerelease_version) {
        if (build_suffix) {
            return `${release_version}-${prerelease_version}.${build_suffix}`;
        }
        return `${release_version}-${prerelease_version}`;
    }

    if (build_suffix) {
        return `${release_version}-${build_suffix}`;
    }

    return release_version;
}

function getSimpleVersion(file_version, arg_build_num, arg_build_branch) {
    // Azure DevOp pass in the build number as $(buildNum).$(buildAttempt).
    // Get the Build number and ignore the attempt number.
    const build_num = parseInt(arg_build_num.split('.')[0]);

    const { release_version, prerelease_version, isBackCompat } = parseFileVersion(file_version, build_num);
    const build_suffix = isBackCompat ? "" : getBuildSuffix(arg_build_branch, build_num, false);
    const fullVersion = generateSimpleVersion(release_version, prerelease_version, build_suffix);
    return fullVersion;
}

function main() {
    let isFull = false;
    let arg_build_num;
    let arg_build_branch;
    let file_version;
    for (let i = 2; i < process.argv.length; i++) {
        if (process.argv[i] === "--full") {
            isFull = true;
            continue;
        }

        if (process.argv[i] === "--build") {
            arg_build_num = process.argv[++i];
            continue;
        }

        if (process.argv[i] === "--branch") {
            arg_build_branch = process.argv[++i];
            continue;
        }

        if (process.argv[i] === "--base") {
            file_version = process.argv[++i];
            continue;
        }

        console.log(`ERROR: Invalid argument ${process.argv[i]}`);
        process.exit(1)
    }

    if (!arg_build_num) {
        arg_build_num = process.env["VERSION_BUILDNUMBER"];
        if (!arg_build_num) {
            console.error("ERROR: Missing VERSION_BUILDNUMBER environment variable");
            process.exit(3);
        }
    }

    if (!arg_build_branch) {
        arg_build_branch = process.env["VERSION_BUILDBRANCH"];
        if (!arg_build_branch) {
            console.error("ERROR: Missing VERSION_BUILD_BRANCH environment variable");
            process.exit(4);
        }
    }

    if (!file_version) {
        file_version = getFileVersion();
        if (!file_version) {
            console.error("ERROR: Missing version in lerna.json/package.json");
            process.exit(2);
        }
    }

    if (isFull) {
        console.log(getFullVersion(file_version, arg_build_num, arg_build_branch));
    } else {
        console.log(getSimpleVersion(file_version, arg_build_num, arg_build_branch));
    }
}

main();

/*
const assert = require("assert").strict;
function test() {
    // Test version <= 0.15, no prerelease
    assert.equal(getFullVersion("0.15.0", "12345", "refs/pull/blah"), "0.15.12345");
    assert.equal(getFullVersion("0.15.0", "12345", "refs/heads/master"), "0.15.12345");
    assert.equal(getFullVersion("0.15.0", "12345.0", "refs/heads/release/0.15"), "0.15.12345");
    assert.equal(getFullVersion("0.15.0", "12345.0", "refs/heads/blah"), "0.15.12345");
    assert.equal(getFullVersion("0.15.0", "12345.0", "refs/tags/v0.15.x"), "0.15.12345");

    // Test version <= 0.15, with prerelease
    assert.equal(getFullVersion("0.15.0-rc", "12345.0", "refs/pull/blah"), "0.15.12345-rc");
    assert.equal(getFullVersion("0.15.0-alpha.1", "12345.0", "refs/heads/master"), "0.15.12345-alpha.1");
    assert.equal(getFullVersion("0.15.0-beta.2.1", "12345.0", "refs/heads/release/0.15"), "0.15.12345-beta.2.1");
    assert.equal(getFullVersion("0.15.0-beta.2.1", "12345.0", "refs/heads/blah"), "0.15.12345-beta.2.1");
    assert.equal(getFullVersion("0.15.0-beta", "12345.0", "refs/tags/v0.15.x"), "0.15.12345-beta");

    // Test version >= 0.16, no prerelease
    assert.equal(getFullVersion("0.16.0", "12345.0", "refs/pull/blah"), "0.16.0--ci.12345.dev");
    assert.equal(getFullVersion("0.16.0", "12345.0", "refs/heads/master"), "0.16.0--ci.12345.official");
    assert.equal(getFullVersion("0.16.0", "12345.0", "refs/heads/release/0.16.0"), "0.16.0--ci.12345.official");
    assert.equal(getFullVersion("0.16.0", "12345.0", "refs/heads/blah"), "0.16.0--ci.12345.manual");
    assert.equal(getFullVersion("0.16.0", "12345.0", "refs/tags/v0.16.0"), "0.16.0");

    // Test version >= 0.16, with prerelease
    assert.equal(getFullVersion("0.16.0-rc", "12345.0", "refs/pull/blah"), "0.16.0-rc.0.0.ci.12345.dev");
    assert.equal(getFullVersion("0.16.0-alpha.1", "12345.0", "refs/heads/master"), "0.16.0-alpha.1.0.ci.12345.official");
    assert.equal(getFullVersion("0.16.0-beta.2.1", "12345.0", "refs/heads/release/0.16.1"), "0.16.0-beta.2.1.ci.12345.official");
    assert.equal(getFullVersion("0.16.0-beta.2.1", "12345.0", "refs/heads/blah"), "0.16.0-beta.2.1.ci.12345.manual");
    assert.equal(getFullVersion("0.16.0-beta", "12345.0", "refs/tags/v0.16.0"), "0.16.0-beta");

    // Test version <= 0.15, no prerelease
    assert.equal(getSimpleVersion("0.15.0", "12345.0", "refs/pull/blah"), "0.15.12345");
    assert.equal(getSimpleVersion("0.15.0", "12345.0", "refs/heads/master"), "0.15.12345");
    assert.equal(getSimpleVersion("0.15.0", "12345.0", "refs/heads/release/0.15"), "0.15.12345");
    assert.equal(getSimpleVersion("0.15.0", "12345.0", "refs/heads/blah"), "0.15.12345");
    assert.equal(getSimpleVersion("0.15.0", "12345.0", "refs/tags/v0.15.x"), "0.15.12345");

    // Test version <= 0.15, with prerelease
    assert.equal(getSimpleVersion("0.15.0-rc", "12345.0", "refs/pull/blah"), "0.15.12345-rc");
    assert.equal(getSimpleVersion("0.15.0-alpha.1", "12345.0", "refs/heads/master"), "0.15.12345-alpha.1");
    assert.equal(getSimpleVersion("0.15.0-beta.2.1", "12345.0", "refs/heads/release/0.15"), "0.15.12345-beta.2.1");
    assert.equal(getSimpleVersion("0.15.0-beta.2.1", "12345.0", "refs/heads/blah"), "0.15.12345-beta.2.1");
    assert.equal(getSimpleVersion("0.15.0-beta", "12345.0", "refs/tags/v0.15.x"), "0.15.12345-beta");

    // Test version >= 0.16, no prerelease
    assert.equal(getSimpleVersion("0.16.0", "12345.0", "refs/pull/blah"), "0.16.0-12345");
    assert.equal(getSimpleVersion("0.16.0", "12345.0", "refs/heads/master"), "0.16.0-12345");
    assert.equal(getSimpleVersion("0.16.0", "12345.0", "refs/heads/release/0.16.0"), "0.16.0-12345");
    assert.equal(getSimpleVersion("0.16.0", "12345.0", "refs/heads/blah"), "0.16.0-12345");
    assert.equal(getSimpleVersion("0.16.0", "12345.0", "refs/tags/v0.16.0"), "0.16.0");

    // Test version >= 0.16, with prerelease
    assert.equal(getSimpleVersion("0.16.0-rc", "12345.0", "refs/pull/blah"), "0.16.0-rc.12345");
    assert.equal(getSimpleVersion("0.16.0-alpha.1", "12345.0", "refs/heads/master"), "0.16.0-alpha.1.12345");
    assert.equal(getSimpleVersion("0.16.0-beta.2.1", "12345.0", "refs/heads/release/0.16.1"), "0.16.0-beta.2.1.12345");
    assert.equal(getSimpleVersion("0.16.0-beta.2.1", "12345.0", "refs/heads/blah"), "0.16.0-beta.2.1.12345");
    assert.equal(getSimpleVersion("0.16.0-beta", "12345.0", "refs/tags/v0.16.0"), "0.16.0-beta");
    console.log("Test passed!");
}

test();
*/