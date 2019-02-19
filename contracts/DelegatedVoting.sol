pragma solidity 0.4.24;
pragma experimental ABIEncoderV2;

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/lib/math/SafeMath.sol";
import "@aragon/os/contracts/lib/math/SafeMath64.sol";
import "@aragon/apps-shared-minime/contracts/MiniMeToken.sol";
import "./DelegationTree.sol";
import "./libraries/ArrayLib.sol";

/**
 * Each vote still contains min accepted quorum and support required values which can be displayed on the UI. However, they're not used to
 * determine execution of anything, just for visibility.
 */

contract DelegatedVoting is AragonApp {
    using SafeMath for uint256;
    using SafeMath64 for uint64;
    using ArrayLib for address[];

    bytes32 public constant CREATE_VOTES_ROLE = keccak256("CREATE_VOTES_ROLE");
    bytes32 public constant MODIFY_SUPPORT_ROLE = keccak256("MODIFY_SUPPORT_ROLE");
    bytes32 public constant MODIFY_QUORUM_ROLE = keccak256("MODIFY_QUORUM_ROLE");

    uint64 public constant PCT_BASE = 10 ** 18; // 0% = 0; 1% = 10^16; 100% = 10^18

    string private constant ERROR_NO_VOTE = "VOTING_NO_VOTE";
    string private constant ERROR_INIT_PCTS = "VOTING_INIT_PCTS";
    string private constant ERROR_CHANGE_SUPPORT_PCTS = "VOTING_CHANGE_SUPPORT_PCTS";
    string private constant ERROR_CHANGE_QUORUM_PCTS = "VOTING_CHANGE_QUORUM_PCTS";
    string private constant ERROR_INIT_SUPPORT_TOO_BIG = "VOTING_INIT_SUPPORT_TOO_BIG";
    string private constant ERROR_CHANGE_SUPPORT_TOO_BIG = "VOTING_CHANGE_SUPP_TOO_BIG";
    string private constant ERROR_CAN_NOT_VOTE = "VOTING_CAN_NOT_VOTE";
    string private constant ERROR_NO_VOTING_POWER = "VOTING_NO_VOTING_POWER";
    string private constant ERROR_NO_DELEGATION_TREE = "VOTING_NO_DELEGATION_TREE";
    string private constant ERROR_VOTER_HAS_DELEGATED = "VOTING_VOTER_HAS_DELEGATED";
    string private constant ERROR_ALREADY_VOTED = "VOTING_ALREADY_VOTED";

    enum VoterState { Absent, Yea, Nay }

    struct Vote {
        uint64 startDate;
        uint64 snapshotBlock;
        uint64 supportRequiredPct;
        uint64 minAcceptQuorumPct;
        uint256 votingPower;

        DelegationTree delegationTree;
        mapping (address => Voter) voters;
        address[] votedFor;
        address[] votedAgainst;
    }

    struct Voter {
        VoterState voterState;
        uint voteArrayPosition;
    }

    MiniMeToken public token;
    uint64 public supportRequiredPct;
    uint64 public minAcceptQuorumPct;
    uint64 public voteTime;

    // We are mimicing an array, we use a mapping instead to make app upgrade more graceful
    mapping (uint256 => Vote) internal votes;
    uint256 public votesLength;

    event StartVote(uint256 indexed voteId, address indexed creator, string metadata);
    event CastVote(uint256 indexed voteId, address indexed voter, bool supports);
    event ChangeSupportRequired(uint64 supportRequiredPct);
    event ChangeMinQuorum(uint64 minAcceptQuorumPct);

    modifier voteExists(uint256 _voteId) {
        require(_voteId < votesLength, ERROR_NO_VOTE);
        _;
    }

    /**
    * @notice Initialize Voting app with `_token.symbol(): string` for governance, minimum support of `@formatPct(_supportRequiredPct)`%, minimum acceptance quorum of `@formatPct(_minAcceptQuorumPct)`%, and a voting duration of `@transformTime(_voteTime)`
    * @param _token MiniMeToken Address that will be used as governance token
    * @param _supportRequiredPct Percentage of yeas in casted votes for a vote to succeed (expressed as a percentage of 10^18; eg. 10^16 = 1%, 10^18 = 100%)
    * @param _minAcceptQuorumPct Percentage of yeas in total possible votes for a vote to succeed (expressed as a percentage of 10^18; eg. 10^16 = 1%, 10^18 = 100%)
    * @param _voteTime Seconds that a vote will be open for token holders to vote (unless enough yeas or nays have been cast to make an early decision)
    */
    function initialize(
        MiniMeToken _token,
        uint64 _supportRequiredPct,
        uint64 _minAcceptQuorumPct,
        uint64 _voteTime
    )
    external
    onlyInit
    {
        initialized();

        require(_minAcceptQuorumPct <= _supportRequiredPct, ERROR_INIT_PCTS);
        require(_supportRequiredPct < PCT_BASE, ERROR_INIT_SUPPORT_TOO_BIG);

        token = _token;
        supportRequiredPct = _supportRequiredPct;
        minAcceptQuorumPct = _minAcceptQuorumPct;
        voteTime = _voteTime;
    }

    /**
    * @notice Change required support to `@formatPct(_supportRequiredPct)`%
    * @param _supportRequiredPct New required support
    */
    function changeSupportRequiredPct(uint64 _supportRequiredPct)
    external
    authP(MODIFY_SUPPORT_ROLE, arr(uint256(_supportRequiredPct), uint256(supportRequiredPct)))
    {
        require(minAcceptQuorumPct <= _supportRequiredPct, ERROR_CHANGE_SUPPORT_PCTS);
        require(_supportRequiredPct < PCT_BASE, ERROR_CHANGE_SUPPORT_TOO_BIG);
        supportRequiredPct = _supportRequiredPct;

        emit ChangeSupportRequired(_supportRequiredPct);
    }

    /**
    * @notice Change minimum acceptance quorum to `@formatPct(_minAcceptQuorumPct)`%
    * @param _minAcceptQuorumPct New acceptance quorum
    */
    function changeMinAcceptQuorumPct(uint64 _minAcceptQuorumPct)
    external
    authP(MODIFY_QUORUM_ROLE, arr(uint256(_minAcceptQuorumPct), uint256(minAcceptQuorumPct)))
    {
        require(_minAcceptQuorumPct <= supportRequiredPct, ERROR_CHANGE_QUORUM_PCTS);
        minAcceptQuorumPct = _minAcceptQuorumPct;

        emit ChangeMinQuorum(_minAcceptQuorumPct);
    }

    /**
    * @notice Create a new vote about "`_metadata`"
    * @param _delegationTree DelegationTree contract
    * @param _metadata Vote metadata
    * @return voteId Id for newly created vote
    */
    function newVote(DelegationTree _delegationTree, string _metadata) external auth(CREATE_VOTES_ROLE) returns (uint256 voteId) {
        return _newVote(_delegationTree, _metadata, true);
    }

    /**
    * @notice Create a new vote about "`_metadata`"
    * @param _delegationTree DelegationTree contract
    * @param _metadata Vote metadata
    * @param _castVote Whether to also cast newly created vote
    * @return voteId id for newly created vote
    */
    function newVote(DelegationTree _delegationTree, string _metadata, bool _castVote)
    external
    auth(CREATE_VOTES_ROLE)
    returns (uint256 voteId)
    {
        return _newVote(_delegationTree, _metadata, _castVote);
    }

    /**
    * @notice Vote `_supports ? 'yea' : 'nay'` in vote #`_voteId`
    * @dev Initialization check is implicitly provided by `voteExists()` as new votes can only be
    *      created via `newVote(),` which requires initialization
    * @param _voteId Id for vote
    * @param _supports Whether voter supports the vote
    */
    function vote(uint256 _voteId, bool _supports) external voteExists(_voteId) {
        require(canVote(_voteId, msg.sender), ERROR_CAN_NOT_VOTE);
        _vote(_voteId, _supports, msg.sender);
    }

    function canVote(uint256 _voteId, address _voter) public view voteExists(_voteId) returns (bool) {
        Vote storage vote_ = votes[_voteId];
        return _isVoteOpen(vote_) && token.balanceOfAt(_voter, vote_.snapshotBlock) > 0;
    }

    function getVote(uint256 _voteId)
    public
    view
    voteExists(_voteId)
    returns (
        bool open,
        uint64 startDate,
        uint64 snapshotBlock,
        uint64 supportRequired,
        uint64 minAcceptQuorum,
        uint256 votingPower,
        address delegationTree
    )
    {
        Vote storage vote_ = votes[_voteId];

        open = _isVoteOpen(vote_);
        startDate = vote_.startDate;
        snapshotBlock = vote_.snapshotBlock;
        supportRequired = vote_.supportRequiredPct;
        minAcceptQuorum = vote_.minAcceptQuorumPct;
        votingPower = vote_.votingPower;
        delegationTree = address(vote_.delegationTree);
    }

    function getVotedForAddresses(uint256 _voteId) public view returns (address[] memory) {
        return votes[_voteId].votedFor;
    }

    function getVotedAgainstAddresses(uint256 _voteId) public view returns (address[] memory) {
        return votes[_voteId].votedAgainst;
    }

    function getVoter(uint256 _voteId, address _voter) public view voteExists(_voteId) returns (Voter) {
        return votes[_voteId].voters[_voter];
    }

    function getVoterState(uint256 _voteId, address _voter) public view voteExists(_voteId) returns (VoterState) {
        return votes[_voteId].voters[_voter].voterState;
    }

    function _newVote(DelegationTree _delegationTree, string _metadata, bool _castVote)
    internal
    returns (uint256 voteId)
    {
        require(_delegationTree != address(0), ERROR_NO_DELEGATION_TREE);

        uint256 votingPower = token.totalSupplyAt(vote_.snapshotBlock); // vote_.snapshotBlock will always be 0. Also uses some weird lookahead referencing. Can't do this in 0.5
        require(votingPower > 0, ERROR_NO_VOTING_POWER);

        voteId = votesLength++;
        Vote storage vote_ = votes[voteId];
        vote_.startDate = getTimestamp64();
        vote_.snapshotBlock = getBlockNumber64() - 1; // avoid double voting in this very block
        vote_.supportRequiredPct = supportRequiredPct;
        vote_.minAcceptQuorumPct = minAcceptQuorumPct;
        vote_.votingPower = votingPower;
        vote_.delegationTree = _delegationTree;

        emit StartVote(voteId, msg.sender, _metadata);

        if (_castVote && canVote(voteId, msg.sender)) {
            _vote(voteId, true, msg.sender);
        }
    }

    function _isUndelegatedVoter(address _voter, DelegationTree _delegationTree) internal view returns (bool) {
        address delegateVoterAddress_ = _delegationTree.getDelegateVoterToAddress(_voter);
        return delegateVoterAddress_ == address(0);
    }

    function _vote(
        uint256 _voteId,
        bool _supports,
        address _voter
    ) internal
    {
        Vote storage vote_ = votes[_voteId];
        Voter storage voter_ = vote_.voters[msg.sender];

        require(_isUndelegatedVoter(msg.sender, vote_.delegationTree), ERROR_VOTER_HAS_DELEGATED);
        require(voter_.voterState != (_supports ? VoterState.Yea : VoterState.Nay), ERROR_ALREADY_VOTED);

        // If already voted and changing vote, remove address from the relevant array of voted address's. Then update
        // the location in the array for the last address in the array that was moved into the deleted address's location.
        if (voter_.voterState == VoterState.Yea) {
            vote_.votedFor._removeElement(voter_.voteArrayPosition);
            _updateVoteArrayStoredIndices(_voteId, vote_.votedFor, voter_.voteArrayPosition);
        } else if (voter_.voterState == VoterState.Nay) {
            vote_.votedAgainst._removeElement(voter_.voteArrayPosition);
            _updateVoteArrayStoredIndices(_voteId, vote_.votedAgainst, voter_.voteArrayPosition);
        }

        // Add the voter address and record the position in the relevant array. Used when the voter wishes to
        // change their vote and must be removed from the voted array.
        if (_supports) {
            voter_.voteArrayPosition = vote_.votedFor.length;
            vote_.votedFor.push(msg.sender);
        } else {
            voter_.voteArrayPosition = vote_.votedAgainst.length;
            vote_.votedAgainst.push(msg.sender);
        }

        voter_.voterState = _supports ? VoterState.Yea : VoterState.Nay;

        emit CastVote(_voteId, _voter, _supports);

    }

    function _updateVoteArrayStoredIndices(uint256 _voteId, address[] memory _voteArray, uint256 _voteArrayPosition) private {
        if (_voteArray.length > 0) {
            Vote storage vote_ = votes[_voteId];
            address movedVoterAddress = _voteArray[_voteArrayPosition];
            Voter storage movedVoter_ = vote_.voters[movedVoterAddress];
            movedVoter_.voteArrayPosition = _voteArrayPosition;
        }
    }

    function _isVoteOpen(Vote storage vote_) internal view returns (bool) {
        return getTimestamp64() <= vote_.startDate.add(voteTime);
    }

    /**
    * @dev Calculates whether `_value` is more than a percentage `_pct` of `_total`
    */
    function _isValuePct(uint256 _value, uint256 _total, uint256 _pct) internal pure returns (bool) {
        if (_total == 0) {
            return false;
        }

        uint256 computedPct = _value.mul(PCT_BASE) / _total;
        return computedPct > _pct;
    }

    /**
    * @notice Get total weight voted in support of vote.
    * @param _voteId VoteId
    * @return total voted in support
    */
    function totalVotedFor(uint256 _voteId) public view returns (uint) {
        Vote storage vote_ = votes[_voteId];
        return _totalVotedWeight(_voteId, vote_.votedFor);
    }

    /**
    * @notice Get total weight voted not in support of vote.
    * @param _voteId VoteId
    * @return total voted not in support
    */
    function totalVotedAgainst(uint256 _voteId) public view returns (uint) {
        Vote storage vote_ = votes[_voteId];
        return _totalVotedWeight(_voteId, vote_.votedAgainst);
    }

    function _totalVotedWeight(uint256 _voteId, address[] memory voteArray) private view returns (uint) {
        Vote storage vote_ = votes[_voteId];
        uint256 totalWeight = 0;

        for (uint256 i = 0; i < voteArray.length; i++) {
            // Must include snapshot block for calculation
            totalWeight += vote_.delegationTree.voteWeightOfAddress(voteArray[i], token);
        }
        return totalWeight;
    }
}