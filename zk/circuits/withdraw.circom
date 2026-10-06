pragma circom 2.1.0;
include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/babyjub.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";

// A note sits in the Mist tree as leaf = Poseidon(commit, denom), commit = Poseidon(Poseidon(Ax, Ay), sh): A the holder's spending
// public key (Baby Jubjub), sh the secret the gardener and the holder share for this note. Spending it proves knowledge of the spending
// private key and of sh, the leaf's place in the tree, and reveals nothing but a nullifier that only the spending key can make.
template MerkleInclusion(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;
    signal output index;
    component h[depth];
    signal cur[depth + 1];
    signal acc[depth + 1];
    cur[0] <== leaf;
    acc[0] <== 0;
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        h[i] = Poseidon(2);
        h[i].inputs[0] <== cur[i] + pathIndices[i] * (pathElements[i] - cur[i]);
        h[i].inputs[1] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);
        cur[i + 1] <== h[i].out;
        acc[i + 1] <== acc[i] + pathIndices[i] * (2 ** i);
    }
    root <== cur[depth];
    index <== acc[depth];
}

template Withdraw(depth) {
    signal input root;
    signal input nullifierHash;
    signal input denom;
    signal input recipient;
    signal input relayer;
    signal input fee;
    signal input spend;
    signal input sh;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    component pk = BabyPbk();
    pk.in <== spend;
    component c1 = Poseidon(2);
    c1.inputs[0] <== pk.Ax;
    c1.inputs[1] <== pk.Ay;
    component c2 = Poseidon(2);
    c2.inputs[0] <== c1.out;
    c2.inputs[1] <== sh;
    component lf = Poseidon(2);
    lf.inputs[0] <== c2.out;
    lf.inputs[1] <== denom;
    component m = MerkleInclusion(depth);
    m.leaf <== lf.out;
    for (var i = 0; i < depth; i++) {
        m.pathElements[i] <== pathElements[i];
        m.pathIndices[i] <== pathIndices[i];
    }
    m.root === root;
    component nf = Poseidon(3);
    nf.inputs[0] <== spend;
    nf.inputs[1] <== sh;
    nf.inputs[2] <== m.index;
    nf.out === nullifierHash;
    // the public inputs the proof must be bound to, used so they cannot be optimised away
    signal recipientSq;
    recipientSq <== recipient * recipient;
    signal relayerSq;
    relayerSq <== relayer * relayer;
    signal feeSq;
    feeSq <== fee * fee;
}

component main {public [root, nullifierHash, denom, recipient, relayer, fee]} = Withdraw(22);
