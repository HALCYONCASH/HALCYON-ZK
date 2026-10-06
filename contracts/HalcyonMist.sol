// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IPoseidonT3Min {
    function hash(uint256[2] memory) external pure returns (uint256);
}

interface IMistVerifierMin {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[6] calldata input) external view returns (bool);
}

/// @title HalcyonMist: the pool where Mist payouts are born private and leave by zero-knowledge proof.
/// Only HalcyonFees sows: a Mist round arrives as a batch of notes, each a commitment (made for one holder from their mist key and a
/// secret the gardener shared with their viewing key) and a denomination from the allowed set. The pool hashes every note into a leaf,
/// the batch into a subtree of 64 and the subtree into its tree of 2^16 batches (Poseidon over BN254, the hash the circuit speaks),
/// keeps the last 64 roots, and emits the note so any browser can rebuild the tree. A withdrawal proves, with the spending key and the
/// shared secret, that some leaf of a known root is the prover's, and reveals only a nullifier the spending key alone can make; the
/// pool pays the denomination minus a fee to any address, the fee to whoever relayed the transaction. Nothing links a withdrawal to
/// a note but the proof's secrets. No owner, no upgrade, no way out but a proof.
contract HalcyonMist {
    uint256 public constant DEPTH = 22;        // 16 levels of batches over 6 levels of notes
    uint256 public constant BATCH_DEPTH = 6;
    uint256 public constant BATCH = 64;
    uint256 public constant ROOTS = 64;        // the roots a proof may still be built against
    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IPoseidonT3Min public immutable poseidon;
    IMistVerifierMin public immutable verifier;
    address public immutable fees;
    uint256[DEPTH + 1] public zeros;           // zeros[i]: the root of an empty subtree of height i
    uint256[DEPTH] private _filled;            // the incremental tree's left children per level (levels BATCH_DEPTH..DEPTH-1 are used)
    uint32 public batches;                     // batches sown so far
    uint256[ROOTS] public roots;
    uint32 public rootIndex;
    mapping(uint256 => bool) public spent;     // nullifier hashes
    mapping(uint256 => bool) public denominations;
    uint256[] private _denominationList;
    bool private _entered;

    event Sown(uint32 indexed batch, address indexed token, uint32 count, uint256 total, uint256 root);
    event Note(uint32 indexed batch, uint16 index, address indexed token, uint256 commit, uint256 denom, bytes32 ephemeral, uint8 viewTag);
    event Spent(uint256 indexed nullifierHash, address indexed recipient, uint256 denom, uint256 fee, address relayer);

    modifier nonReentrant() { require(!_entered, "reentrant"); _entered = true; _; _entered = false; }

    constructor(address poseidon_, address verifier_, address fees_, uint256[] memory denoms) {
        require(poseidon_ != address(0) && verifier_ != address(0) && fees_ != address(0), "zero");
        poseidon = IPoseidonT3Min(poseidon_);
        verifier = IMistVerifierMin(verifier_);
        fees = fees_;
        // the hash must be the circuit's: Poseidon(1, 2) over BN254 with circomlib's parameters
        require(poseidon.hash([uint256(1), uint256(2)]) == 7853200120776062878684798364095072458815029376092732009249414926327459813530, "poseidon");
        uint256 z = 0;
        for (uint256 i = 0; i < DEPTH; i++) {
            zeros[i] = z;
            z = poseidon.hash([z, z]);
        }
        zeros[DEPTH] = z;
        roots[0] = z;
        require(denoms.length > 0 && denoms.length <= 8, "denominations");
        for (uint256 i = 0; i < denoms.length; i++) {
            require(denoms[i] > 0 && !denominations[denoms[i]], "denomination");
            denominations[denoms[i]] = true;
            _denominationList.push(denoms[i]);
        }
    }

    function denominationList() external view returns (uint256[] memory) { return _denominationList; }
    function root() public view returns (uint256) { return roots[rootIndex]; }

    /// @notice Is `r` one of the last ROOTS roots (a proof built a few batches ago still goes through)?
    function isKnownRoot(uint256 r) public view returns (bool) {
        if (r == 0) return false;
        uint32 i = rootIndex;
        for (uint256 n = 0; n < ROOTS; n++) {
            if (roots[i] == r) return true;
            if (i == 0) i = uint32(ROOTS);
            i--;
        }
        return false;
    }

    /// @notice HalcyonFees sows a round: up to 64 notes, with exactly their denominations in ETH. Each note is announced with the
    /// ephemeral public key and a view tag so that the holder's viewing key finds it.
    function sow(address token, uint256[] calldata commits, uint256[] calldata denoms, bytes32[] calldata ephemerals, uint8[] calldata viewTags) external payable returns (uint32 batch) {
        require(msg.sender == fees, "fees");
        uint256 n = commits.length;
        require(n > 0 && n <= BATCH && denoms.length == n && ephemerals.length == n && viewTags.length == n, "lengths");
        require(batches < 2 ** (DEPTH - BATCH_DEPTH), "full");
        uint256 total = 0;
        uint256[] memory level = new uint256[](n);
        batch = batches;
        for (uint256 i = 0; i < n; i++) {
            require(commits[i] < FIELD && commits[i] != 0, "commit");
            require(denominations[denoms[i]], "denomination");
            total += denoms[i];
            level[i] = poseidon.hash([commits[i], denoms[i]]);
            emit Note(batch, uint16(i), token, commits[i], denoms[i], ephemerals[i], viewTags[i]);
        }
        require(msg.value == total, "value");
        // the batch's subtree, zero-padded to 64; an all-zero pair is the next zero, no hash needed
        for (uint256 d = 0; d < BATCH_DEPTH; d++) {
            uint256 m = (level.length + 1) / 2;
            uint256[] memory next = new uint256[](m);
            for (uint256 i = 0; i < m; i++) {
                uint256 l = level[2 * i];
                uint256 r = 2 * i + 1 < level.length ? level[2 * i + 1] : zeros[d];
                next[i] = (l == zeros[d] && r == zeros[d]) ? zeros[d + 1] : poseidon.hash([l, r]);
            }
            level = next;
        }
        // the subtree's root goes into the tree of batches (an incremental tree over levels BATCH_DEPTH..DEPTH-1)
        uint256 cur = level[0];
        uint256 idx = batch;
        for (uint256 l = BATCH_DEPTH; l < DEPTH; l++) {
            uint256 left;
            uint256 right;
            if (idx % 2 == 0) { left = cur; right = zeros[l]; _filled[l] = cur; }
            else { left = _filled[l]; right = cur; }
            cur = poseidon.hash([left, right]);
            idx /= 2;
        }
        batches = batch + 1;
        rootIndex = uint32((rootIndex + 1) % ROOTS);
        roots[rootIndex] = cur;
        emit Sown(batch, token, uint32(n), total, cur);
    }

    /// @notice Spend a note: a Groth16 proof over (root, nullifierHash, denom, recipient, relayer, fee). The recipient gets the
    /// denomination minus the fee, the relayer the fee; anyone may relay, the proof binds both.
    function withdraw(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256 root_, uint256 nullifierHash, uint256 denom, address payable recipient, address payable relayer, uint256 fee) external nonReentrant {
        require(isKnownRoot(root_), "root");
        require(!spent[nullifierHash], "spent");
        require(denominations[denom], "denomination");
        require(fee <= denom, "fee");
        require(recipient != address(0), "recipient");
        require(verifier.verifyProof(a, b, c, [root_, nullifierHash, denom, uint256(uint160(address(recipient))), uint256(uint160(address(relayer))), fee]), "proof");
        spent[nullifierHash] = true;
        (bool ok, ) = recipient.call{value: denom - fee}("");
        require(ok, "send");
        if (fee > 0) {
            (bool okFee, ) = relayer.call{value: fee}("");
            require(okFee, "fee send");
        }
        emit Spent(nullifierHash, recipient, denom, fee, relayer);
    }
}
