const bn = require("bn.js")
const { assertRevert } = require('@aragon/test-helpers/assertThrow')

const DelegatedVoting = artifacts.require("DelegatedVoting")
const DelegationTree = artifacts.require("DelegationTree")
const DAOFactory = artifacts.require('@aragon/os/contracts/factory/DAOFactory')
const EVMScriptRegistryFactory = artifacts.require('@aragon/os/contracts/factory/EVMScriptRegistryFactory')
const ACL = artifacts.require('@aragon/os/contracts/acl/ACL')
const Kernel = artifacts.require('@aragon/os/contracts/kernel/Kernel')
const MiniMeToken = artifacts.require('@aragon/apps-shared-minime/contracts/MiniMeToken')

// TO DELETE
const AppProxyUpgradable = artifacts.require("@aragon/os/contracts/apps/AppProxyUpgradeable")

const ANY_ADDR = '0xffffffffffffffffffffffffffffffffffffffff'
const NULL_ADDRESS = '0x0000000000000000000000000000000000000000'

const bigExp = (x, y) => (new bn(x)).mul((new bn(10)).pow(new bn(y)))
const pct16 = x => bigExp(x, 16)
const neededSupport = pct16(50)
const minimumAcceptanceQuorum = pct16(20)
const votingTime = 1000

contract("DelegatedVoting", accounts => {

    let votingBase, daoFactory, delegatedVoting, delegationTree, token

    // TO DELETE
    let acl, kernel

    let APP_MANAGER_ROLE, CREATE_VOTES_ROLE, MODIFY_SUPPORT_ROLE, MODIFY_QUORUM_ROLE

    const owner = accounts[0]

    before(async () => {
        const kernelBase = await Kernel.new(true) // petrify immediately
        const aclBase = await ACL.new()
        const evmScriptRegistryFactory = await EVMScriptRegistryFactory.new()
        daoFactory = await DAOFactory.new(kernelBase.address, aclBase.address, evmScriptRegistryFactory.address)
        votingBase = await DelegatedVoting.new()

        APP_MANAGER_ROLE = await kernelBase.APP_MANAGER_ROLE()
        CREATE_VOTES_ROLE = await votingBase.CREATE_VOTES_ROLE()
        MODIFY_SUPPORT_ROLE = await votingBase.MODIFY_SUPPORT_ROLE()
        MODIFY_QUORUM_ROLE = await votingBase.MODIFY_QUORUM_ROLE()
    })

    beforeEach(async () => {
        const newKernelReceipt = await daoFactory.newDAO(owner)
        kernel = await Kernel.at(newKernelReceipt.logs.filter(log => log.event === 'DeployDAO')[0].args.dao)
        acl = await ACL.at(await kernel.acl())

        await acl.createPermission(owner, kernel.address, APP_MANAGER_ROLE, owner, { from: owner })

        const newAppReceipt = await kernel.newAppInstance('0x1234', votingBase.address, '0x', false, { from: owner })
        delegatedVoting = await DelegatedVoting.at(newAppReceipt.logs.filter(log => log.event === 'NewAppProxy')[0].args.proxy)

        await acl.createPermission(ANY_ADDR, delegatedVoting.address, CREATE_VOTES_ROLE, owner, { from: owner })
        await acl.createPermission(ANY_ADDR, delegatedVoting.address, MODIFY_SUPPORT_ROLE, owner, { from: owner })
        await acl.createPermission(ANY_ADDR, delegatedVoting.address, MODIFY_QUORUM_ROLE, owner, { from: owner })

        token = await MiniMeToken.new(NULL_ADDRESS, NULL_ADDRESS, 0, 'n', 0, 'n', true)
        await token.generateTokens(owner, 1000)
        await delegatedVoting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingTime)
        delegationTree = await DelegationTree.new()
    })

    describe("newVote(DelegationTree _delegationTree, string _metadata)", () => {

        it("sets delegation tree address", async () => {
            const newVoteReceipt = await delegatedVoting.newVote(delegationTree.address, "")

            const voteId = newVoteReceipt.logs.filter(log => log.event === "StartVote")[0].args.voteId
            const voteDetails = await delegatedVoting.getVote(voteId)
            assert.equal(voteDetails.delegationTree, delegationTree.address)
        })
    })

    describe("vote(uint256 _voteId, bool _supports)", () => {

        let voteId
        const voter = accounts[0]

        beforeEach(async () => {
            const newVoteReceipt = await delegatedVoting.newVote(delegationTree.address, "")
            voteId = newVoteReceipt.logs.filter(log => log.event === "StartVote")[0].args.voteId
        })

        it("fails when voter has delegated their vote", async () => {
            await delegationTree.delegateVote(accounts[1])
            await assertRevert(async () => delegatedVoting.vote(voteId, true))
        })

        it("updates voter with having voted and correct decision", async () => {
            await delegatedVoting.vote(voteId, true, { from: voter })
            const voter = await delegatedVoting.getVoter(voteId, voter)

            assert.isTrue(voter.inFavour, "Vote direction not as expected")
            assert.equal(voter.voteArrayPosition, 0, "Vote direction array position not as expected")
            assert.isTrue(voter.hasVoted, "Has voted bool not as expected")
        })

        // it("updates voter with having voted and correct decision after 2 votes are cast for same decision", async () => {
        //     await delegatedVote.vote(true, {from:accounts[0]})
        //     await delegatedVote.vote(true, {from:accounts[1]})
        //     const voter2 = await delegatedVote.voters(accounts[1])
        //
        //     assert.isTrue(voter2.inFavour, "Vote direction not as expected")
        //     assert.equal(voter2.voteArrayPosition.toNumber(), 1, "Vote direction array position not as expected")
        //     assert.isTrue(voter2.hasVoted, "Has voted bool not as expected")
        // })
        //
        // it("updates voted 'for' address array", async () => {
        //     await delegatedVote.vote(true, {from:accounts[0]})
        //     await delegatedVote.vote(true, {from:accounts[1]})
        //     const expectedVotedForAddresses = [accounts[0], accounts[1]]
        //     const actualVotedForAddresses = await delegatedVote.getVotedForAddresses()
        //
        //     assert.deepEqual(actualVotedForAddresses, expectedVotedForAddresses, "Voted for addresses are not as expected")
        // })
        //
        // it("updates voted 'against' address array", async () => {
        //     await delegatedVote.vote(false, {from:accounts[0]})
        //     await delegatedVote.vote(false, {from:accounts[1]})
        //     const expectedVotedForAddresses = [accounts[0], accounts[1]]
        //     const actualVotedForAddresses = await delegatedVote.getVotedAgainstAddresses()
        //
        //     assert.deepEqual(actualVotedForAddresses, expectedVotedForAddresses, "Voted for addresses are not as expected")
        // })
        //
        // it("removes address from voted 'for' address array when vote is changed", async () => {
        //     await delegatedVote.vote(true, {from:accounts[0]})
        //     await delegatedVote.vote(false, {from:accounts[0]})
        //     const votedForAddresses = await delegatedVote.getVotedForAddresses();
        //     const votedAgainstAddresses = await delegatedVote.getVotedAgainstAddresses();
        //
        //     assert.deepEqual(votedForAddresses, [], "Voted for addresses are not as expected")
        //     assert.deepEqual(votedAgainstAddresses, [accounts[0]], "Voted against addresses are not as expected")
        // })
        //
        // it("removes address from voted 'against' address array when vote is changed", async () => {
        //     await delegatedVote.vote(false, {from:accounts[0]})
        //     await delegatedVote.vote(true, {from:accounts[0]})
        //     const votedForAddresses = await delegatedVote.getVotedForAddresses();
        //     const votedAgainstAddresses = await delegatedVote.getVotedAgainstAddresses();
        //
        //     assert.deepEqual(votedForAddresses, [accounts[0]], "Voted for addresses are not as expected")
        //     assert.deepEqual(votedAgainstAddresses, [], "Voted against addresses are not as expected")
        // })
    })
})
