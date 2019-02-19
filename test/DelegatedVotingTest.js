const bn = require("bn.js")
const {assertRevert} = require('@aragon/test-helpers/assertThrow')
const {range, from} = require("rxjs")
const {mergeMap} = require("rxjs/operators")

const DelegatedVoting = artifacts.require("DelegatedVoting")
const DelegationTree = artifacts.require("DelegationTree")
const DAOFactory = artifacts.require('@aragon/os/contracts/factory/DAOFactory')
const EVMScriptRegistryFactory = artifacts.require('@aragon/os/contracts/factory/EVMScriptRegistryFactory')
const ACL = artifacts.require('@aragon/os/contracts/acl/ACL')
const Kernel = artifacts.require('@aragon/os/contracts/kernel/Kernel')
const MiniMeToken = artifacts.require('@aragon/apps-shared-minime/contracts/MiniMeToken')

const ANY_ADDR = '0xffffffffffffffffffffffffffffffffffffffff'
const NULL_ADDRESS = '0x0000000000000000000000000000000000000000'

const bigExp = (x, y) => (new bn(x)).mul((new bn(10)).pow(new bn(y)))
const pct16 = x => bigExp(x, 16)
const neededSupport = pct16(50)
const minimumAcceptanceQuorum = pct16(20)
const votingTime = 1000

contract("DelegatedVoting", accounts => {

    let votingBase, daoFactory, kernelBase, delegatedVoting, delegationTree, token
    let APP_MANAGER_ROLE, CREATE_VOTES_ROLE, MODIFY_SUPPORT_ROLE, MODIFY_QUORUM_ROLE
    let voteId
    const owner = accounts[0]

    before(async () => {
        await createStatelessContracts()
        await setPermissionConstants()
    })

    const createStatelessContracts = async () => {
        kernelBase = await Kernel.new(true)
        const aclBase = await ACL.new()
        const evmScriptRegistryFactory = await EVMScriptRegistryFactory.new()
        daoFactory = await DAOFactory.new(kernelBase.address, aclBase.address, evmScriptRegistryFactory.address)
        votingBase = await DelegatedVoting.new()
    }

    const setPermissionConstants = async () => {
        APP_MANAGER_ROLE = await kernelBase.APP_MANAGER_ROLE()
        CREATE_VOTES_ROLE = await votingBase.CREATE_VOTES_ROLE()
        MODIFY_SUPPORT_ROLE = await votingBase.MODIFY_SUPPORT_ROLE()
        MODIFY_QUORUM_ROLE = await votingBase.MODIFY_QUORUM_ROLE()
    }

    beforeEach(async () => {
        await createDaoProxyContractsWithPermissions()
        await createTokenContractAndDistributeTokens()

        await delegatedVoting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingTime)
        delegationTree = await DelegationTree.new()
    })

    const createDaoProxyContractsWithPermissions = async () => {
        const newKernelReceipt = await daoFactory.newDAO(owner)
        const kernel = await Kernel.at(newKernelReceipt.logs.filter(log => log.event === 'DeployDAO')[0].args.dao)
        const acl = await ACL.at(await kernel.acl())

        await acl.createPermission(owner, kernel.address, APP_MANAGER_ROLE, owner, {from: owner})

        const newAppReceipt = await kernel.newAppInstance('0x1234', votingBase.address, '0x', false, {from: owner})
        delegatedVoting = await DelegatedVoting.at(newAppReceipt.logs.filter(log => log.event === 'NewAppProxy')[0].args.proxy)

        await acl.createPermission(ANY_ADDR, delegatedVoting.address, CREATE_VOTES_ROLE, owner, {from: owner})
        await acl.createPermission(ANY_ADDR, delegatedVoting.address, MODIFY_SUPPORT_ROLE, owner, {from: owner})
        await acl.createPermission(ANY_ADDR, delegatedVoting.address, MODIFY_QUORUM_ROLE, owner, {from: owner})
    }

    const createTokenContractAndDistributeTokens = async () => {
        token = await MiniMeToken.new(NULL_ADDRESS, NULL_ADDRESS, 0, 'n', 0, 'n', true)
        await token.generateTokens(owner, 1000)
    }

    const createNewVoteAndRecordId = async () => {
        const newVoteReceipt = await delegatedVoting.newVote(delegationTree.address, "", false)
        voteId = newVoteReceipt.logs.filter(log => log.event === "StartVote")[0].args.voteId
    }

    describe("newVote(DelegationTree _delegationTree, string _metadata)", () => {

        it("sets delegation tree address", async () => {
            const newVoteReceipt = await delegatedVoting.newVote(delegationTree.address, "")

            const voteId = newVoteReceipt.logs.filter(log => log.event === "StartVote")[0].args.voteId
            const voteDetails = await delegatedVoting.getVote(voteId)
            assert.equal(voteDetails.delegationTree, delegationTree.address)
        })
    })

    describe("vote(uint256 _voteId, bool _supports)", () => {

        const voter = accounts[0]

        beforeEach(async () => {
            await token.transfer(accounts[1], 1)
            await createNewVoteAndRecordId()
        })

        it("reverts when voter has delegated their vote", async () => {
            await delegationTree.delegateVote(accounts[1])
            await assertRevert(async () => delegatedVoting.vote(voteId, true))
        })

        it("reverts when voter votes the same way twice", async () => {
            await delegatedVoting.vote(voteId, true)
            await assertRevert(async () => delegatedVoting.vote(voteId, true))
        })

        it("updates voter with having voted and correct decision", async () => {
            await delegatedVoting.vote(voteId, true, {from: voter})

            const voterData = await delegatedVoting.getVoter(voteId, voter)
            assert.equal(voterData.voterState, 1)
            assert.equal(voterData.voteArrayPosition, 0)
        })

        it("updates voter with correct voterState and voteArrayPosition after 2 votes are cast", async () => {
            await delegatedVoting.vote(voteId, true, {from: accounts[0]})
            await delegatedVoting.vote(voteId, true, {from: accounts[1]})

            const voter2 = await delegatedVoting.getVoter(voteId, accounts[1])
            assert.equal(voter2.voterState, 1)
            assert.equal(voter2.voteArrayPosition, 1)
        })

        it("updates voter with correct voteArrayPosition after being moved in the vote array", async () => {
            await delegatedVoting.vote(voteId, true, {from: accounts[0]})
            await delegatedVoting.vote(voteId, true, {from: accounts[1]})
            await delegatedVoting.vote(voteId, false, {from: accounts[0]})

            const voter2 = await delegatedVoting.getVoter(voteId, accounts[1])
            assert.equal(voter2.voteArrayPosition, 0)
        })

        it("updates voted 'for' address array", async () => {
            const expectedVotedForAddresses = [accounts[0], accounts[1]]

            await delegatedVoting.vote(voteId, true, {from: accounts[0]})
            await delegatedVoting.vote(voteId, true, {from: accounts[1]})

            const actualVotedForAddresses = await delegatedVoting.getVotedForAddresses(voteId)
            assert.deepEqual(actualVotedForAddresses, expectedVotedForAddresses)
        })

        it("updates voted 'against' address array", async () => {
            const expectedVotedForAddresses = [accounts[0], accounts[1]]

            await delegatedVoting.vote(voteId, false, {from: accounts[0]})
            await delegatedVoting.vote(voteId, false, {from: accounts[1]})

            const actualVotedForAddresses = await delegatedVoting.getVotedAgainstAddresses(voteId)
            assert.deepEqual(actualVotedForAddresses, expectedVotedForAddresses)
        })

        it("removes address from voted 'for' address array when vote is changed", async () => {
            await delegatedVoting.vote(voteId, true, {from: accounts[0]})
            await delegatedVoting.vote(voteId, false, {from: accounts[0]})

            const votedForAddresses = await delegatedVoting.getVotedForAddresses(voteId);
            const votedAgainstAddresses = await delegatedVoting.getVotedAgainstAddresses(voteId);
            assert.deepEqual(votedForAddresses, [])
            assert.deepEqual(votedAgainstAddresses, [accounts[0]])
        })

        it("removes address from voted 'against' address array when vote is changed", async () => {
            await delegatedVoting.vote(voteId, false, {from: accounts[0]})
            await delegatedVoting.vote(voteId, true, {from: accounts[0]})

            const votedForAddresses = await delegatedVoting.getVotedForAddresses(voteId);
            const votedAgainstAddresses = await delegatedVoting.getVotedAgainstAddresses(voteId);
            assert.deepEqual(votedForAddresses, [accounts[0]])
            assert.deepEqual(votedAgainstAddresses, [])
        })
    })

    describe("totalVotedFor()", () => {

        beforeEach(async () => {
            await distributeTokens$(3).toPromise()
            await createNewVoteAndRecordId()
        })

        it("calculates correct weight for one voter", async () => {
            const expectedWeightInSupport = 1
            delegatedVoting.vote(voteId, true, {from: accounts[1]})

            const actualWeightInSupport = await delegatedVoting.totalVotedFor(voteId)

            assert.equal(actualWeightInSupport, expectedWeightInSupport)
        })

        it("calculates correct weight for many voters", async () => {
            const expectedWeightInSupport = 6
            await doVote$(true, 3).toPromise()

            console.log(await token.balanceOf(accounts[1]))
            console.log(await token.balanceOf(accounts[2]))
            console.log(await token.balanceOf(accounts[3]))

            console.log(await delegatedVoting.getVotedForAddresses(voteId))

            const actualWeightInSupport = await delegatedVoting.totalVotedFor(voteId);

            assert.equal(actualWeightInSupport.toNumber(), expectedWeightInSupport)
        })
    })

    describe("totalVotedAgainst()", () => {

        beforeEach(async () => {
            await distributeTokens$(3).toPromise()
            await createNewVoteAndRecordId()
        })

        it("calculates correct weight for one voter", async () => {
            const expectedWeightNotInSupport = 1
            delegatedVoting.vote(voteId, false, {from: accounts[1]})

            const actualWeightNotInSupport = await delegatedVoting.totalVotedAgainst(voteId)

            assert.equal(actualWeightNotInSupport, expectedWeightNotInSupport)
        })

        it("calculates correct weight for many voters", async () => {
            const expectedWeightNotInSupport = 6
            await doVote$(false, 3).toPromise()

            const actualWeightFor = await delegatedVoting.totalVotedAgainst(voteId);

            assert.equal(actualWeightFor, expectedWeightNotInSupport)
        })
    })

    // Distributes an increasing number of tokens from account 1 to specified numberOfAccounts + 1
    const distributeTokens$ = (numberOfAccounts) => range(1, numberOfAccounts).pipe(
        mergeMap(i => token.transfer(accounts[i], i, {from: owner}))
    )

    // Votes from the specified number of accounts
    const doVote$ = (supports, numberOfAccounts) => range(1, numberOfAccounts).pipe(
        mergeMap(i => delegatedVoting.vote(voteId, supports, {from: accounts[i]}))
    )
})
