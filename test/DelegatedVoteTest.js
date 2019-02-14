const VoteToken = artifacts.require("VoteToken.sol")
const DelegationTree = artifacts.require("DelegationTree.sol")
const DelegatedVote = artifacts.require("DelegatedVote.sol")
const { assertRevert } = require("@aragon/os/test/helpers/assertThrow")
const { range, from } = require("rxjs")
const { mergeMap } = require("rxjs/operators")

contract("DelegatedVote", accounts => {

    let voteToken, delegationTree, delegatedVote
    const tokenCreator = accounts[9]

    beforeEach(async () => {
        voteToken = await VoteToken.new({ from: tokenCreator })
        delegationTree = await DelegationTree.new()
        delegatedVote = await DelegatedVote.new(voteToken.address, delegationTree.address)
    })

    describe("vote(bool _inFavour)", () => {

        it("updates voter with having voted and correct decision", async () => {
            await delegatedVote.vote(true)
            const voter = await delegatedVote.voters(accounts[0])

            assert.isTrue(voter.inFavour, "Vote direction not as expected")
            assert.equal(voter.voteArrayPosition, 0, "Vote direction array position not as expected")
            assert.isTrue(voter.hasVoted, "Has voted bool not as expected")
        })

        it("updates voter with having voted and correct decision after 2 votes are cast for same decision", async () => {
            await delegatedVote.vote(true, {from:accounts[0]})
            await delegatedVote.vote(true, {from:accounts[1]})
            const voter2 = await delegatedVote.voters(accounts[1])

            assert.isTrue(voter2.inFavour, "Vote direction not as expected")
            assert.equal(voter2.voteArrayPosition.toNumber(), 1, "Vote direction array position not as expected")
            assert.isTrue(voter2.hasVoted, "Has voted bool not as expected")
        })

        it("updates voted 'for' address array", async () => {
            await delegatedVote.vote(true, {from:accounts[0]})
            await delegatedVote.vote(true, {from:accounts[1]})
            const expectedVotedForAddresses = [accounts[0], accounts[1]]
            const actualVotedForAddresses = await delegatedVote.getVotedForAddresses()

            assert.deepEqual(actualVotedForAddresses, expectedVotedForAddresses, "Voted for addresses are not as expected")
        })

        it("updates voted 'against' address array", async () => {
            await delegatedVote.vote(false, {from:accounts[0]})
            await delegatedVote.vote(false, {from:accounts[1]})
            const expectedVotedForAddresses = [accounts[0], accounts[1]]
            const actualVotedForAddresses = await delegatedVote.getVotedAgainstAddresses()

            assert.deepEqual(actualVotedForAddresses, expectedVotedForAddresses, "Voted for addresses are not as expected")
        })

        it("removes address from voted 'for' address array when vote is changed", async () => {
            await delegatedVote.vote(true, {from:accounts[0]})
            await delegatedVote.vote(false, {from:accounts[0]})
            const votedForAddresses = await delegatedVote.getVotedForAddresses();
            const votedAgainstAddresses = await delegatedVote.getVotedAgainstAddresses();

            assert.deepEqual(votedForAddresses, [], "Voted for addresses are not as expected")
            assert.deepEqual(votedAgainstAddresses, [accounts[0]], "Voted against addresses are not as expected")
        })

        it("removes address from voted 'against' address array when vote is changed", async () => {
            await delegatedVote.vote(false, {from:accounts[0]})
            await delegatedVote.vote(true, {from:accounts[0]})
            const votedForAddresses = await delegatedVote.getVotedForAddresses();
            const votedAgainstAddresses = await delegatedVote.getVotedAgainstAddresses();

            assert.deepEqual(votedForAddresses, [accounts[0]], "Voted for addresses are not as expected")
            assert.deepEqual(votedAgainstAddresses, [], "Voted against addresses are not as expected")
        })

        it("fails when voter has delegated their vote", async () => {
            await delegationTree.delegateVote(accounts[1])
            await assertRevert(async () => delegatedVote.vote(true))
        })
    })

    describe("totalVotedFor()", () => {

        it("calculates correct weight for one voter", async () => {
            const expectedWeightFor = 1
            await distributeTokens$(1).toPromise()
            await doVote$(true, 1).toPromise()

            const actualWeightFor = await delegatedVote.totalVotedFor()

            assert.equal(actualWeightFor, expectedWeightFor)
        })

        it("calculates correct weight for many voters", async () => {
            const expectedWeightFor = 6
            await distributeTokens$(3).toPromise()
            await doVote$(true, 3).toPromise()

            const actualWeightFor = await delegatedVote.totalVotedFor();

            assert.equal(actualWeightFor, expectedWeightFor)
        })
    })

    describe("totalVotedAgainst()", () => {

        it("calculates correct weight for one voter", async () => {
            const expectedWeightFor = 1
            await distributeTokens$(1).toPromise()
            await doVote$(false, 1).toPromise()

            const actualWeightFor = await delegatedVote.totalVotedAgainst()

            assert.equal(actualWeightFor, expectedWeightFor)
        })

        it("calculates correct weight for many voters", async () => {
            const expectedWeightFor = 6
            await distributeTokens$(3).toPromise()
            await doVote$(false, 3).toPromise()

            const actualWeightFor = await delegatedVote.totalVotedAgainst();

            assert.equal(actualWeightFor, expectedWeightFor)
        })
    })


    // Using Rx here because for some reason, voteToken is sometimes undefined in the distributeTokens function.
    // None of my research could uncover why, experimented with many approaches. Rx alternative works.
    const distributeTokens$ = (numberOfAccounts) => range(0, numberOfAccounts).pipe(
        mergeMap(i => voteToken.transfer(accounts[i], i + 1, { from: tokenCreator }))
    )

    const doVote$ = (inFavour, numberOfAccounts) => range(0, numberOfAccounts).pipe(
        mergeMap(i => delegatedVote.vote(inFavour, { from: accounts[i] }))
    )

    // distributeTokens = async (numberOfAccounts) => {
    //     for (let i = 0; i < numberOfAccounts; i++) {
    //         await voteToken.transfer(accounts[i], i + 1, {from: tokenCreator})
    //     }
    // }
    //
    // doVote = async (inFavour, numberOfAccounts) => {
    //     for (let i = 0; i < numberOfAccounts; i++) {
    //         await delegatedVote.vote(inFavour, { from: accounts[i] })
    //     }
    // }

    // asyncForEach = async (array, callback) => {
    //     for (let i = 0; i < array.length; i++) {
    //         await callback(array[i], i, array)
    //     }
    // }
    // distributeTokens2 = async (numberOfAccounts) =>
    //     await asyncForEach(Array.from(new Array(numberOfAccounts).keys()), async i => { await voteToken.transfer(accounts[i], i + 1, { from: tokenCreator }) })
    //
    // distributeTokens3 = async (numberOfAccounts) => {
    //     Array.from(new Array(numberOfAccounts).keys())
    //         .forEach(async i => await voteToken.transfer(accounts[i], i + 1, { from: tokenCreator }))
    // }
    //


})