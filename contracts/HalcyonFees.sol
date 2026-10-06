// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Min, IHalcyonTokenMin, IWETH9, ISwapRouter02Min, Hop} from "./Interfaces.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";

interface IHalcyonSwapMin {
    function buy(PoolKey calldata key, uint256 minOut, address to, uint256 deadline) external payable returns (uint256 out);
    function swapPath(Hop[] calldata path, address currencyIn, uint256 amountIn, uint256 minOut, address to, uint256 deadline) external payable returns (uint256 used, uint256 out);
}

interface IHalcyonMistMin {
    function sow(address token, uint256[] calldata commits, uint256[] calldata denoms, bytes32[] calldata ephemerals, uint8[] calldata viewTags) external payable returns (uint32 batch);
}

/// @title HalcyonFees: where every fee of every Halcyon coin lands, and where the coin's module decides what it becomes.
/// A coin's fee is the 1% its Uniswap pool charges on every trade. Halcyon holds all of that pool's liquidity, locked forever, so
/// the whole 1% is the coin's; the gardener collects it through the lockers and it lands here as ETH. 20% of every deposit is the
/// platform's. 80% is the coin's, and the coin's module says what it becomes:
///   Roots    pushed to the creator at once (or waits in `claimable` if the creator cannot receive ETH)
///   Rain     waits in the coin's pot; the gardener pays it to holders pro rata, in ETH, and pays the gas
///   Prune    waits in the pot; the gardener buys the coin back with it and burns what it bought
///   Harvest  waits in the pot; the gardener buys a tokenized stock from the allow-list (through Uniswap v3 or v4) and pays it out to holders
///   Branch   pushed at once to the addresses the creator named, in the shares the creator set
///   Clover   waits in the pot; the gardener opens a draw on a future block and pays the whole pot to one holder its hash picks
///   Rings    waits in the pot; the gardener pays it to holders weighted by balance and by how long they have held
///   Mist     waits in the pot; the gardener sows it into the mist pool as private notes, one per holder and denomination, that the
///            holder alone can find (with a viewing key) and spend (with a zero-knowledge proof) to any address
/// The gardener can only move a coin's pot into that coin's holders, that coin's burn, that coin's stock or the mist pool; it can
/// never send a pot to an arbitrary address, never touch the platform's share, never change a module. The creator changes the module.
/// Mist is the one place the chain cannot check who a note is for (that is its point): the gardener's recipients there are the
/// commitments it sows, and every holder can check that their own notes arrive and add up to their share.
contract HalcyonFees {
    uint16 public constant PLATFORM_BPS = 2_000; // 20% of every fee
    uint8 public constant MODULE_ROOTS = 0;
    uint8 public constant MODULE_RAIN = 1;
    uint8 public constant MODULE_PRUNE = 2;
    uint8 public constant MODULE_HARVEST = 3;
    uint8 public constant MODULE_BRANCH = 4;
    uint8 public constant MODULE_CLOVER = 5;
    uint8 public constant MODULE_RINGS = 6;
    uint8 public constant MODULE_MIST = 7;
    uint8 public constant POOL_V3 = 0;
    uint8 public constant POOL_V4 = 1;
    uint24 public constant V3_FEE = 10_000;      // the 1% tier
    int24 public constant V4_TICK_SPACING = 200;
    uint8 public constant MAX_BRANCHES = 8;
    uint256 public constant DRAW_DELAY = 3;      // blocks between a clover draw opening and the block whose hash draws
    uint256 public constant DRAW_WINDOW = 250;   // blocks after that in which the draw can be paid (blockhash is available for 256)
    uint256 public constant MIST_KEY_LENGTH = 64; // two packed Baby Jubjub points: the spending public key, then the viewing one

    struct Coin {
        address creator;
        uint8 module;
        uint8 pool;           // POOL_V3 or POOL_V4
        address stock;
        uint256 pot;          // the coin's 80% waiting for its module (ETH)
        uint256 received;     // every deposit, gross, for the record
        uint256 paid;         // what left the pot, or was pushed, for the module
        uint256 stockHeld;    // stock tokens bought and not yet paid out
        uint64 drawBlock;     // Clover: the block whose hash draws the winner, 0 when no draw is open
    }

    struct Branches { address[] to; uint16[] bps; }

    address public platform;
    address public gardener;      // the platform's bot: collects, pays, prunes, harvests, draws, sows
    address public launchpad;
    address public locker;      // Uniswap v3 positions
    address public v4Locker;    // Uniswap v4 positions
    address public hook;        // the Halcyon v4 hook (part of every v4 pool key)
    address public immutable weth;
    address public immutable swapRouter;  // Uniswap v3 SwapRouter02 (buybacks on v3 pools, stock buys through v3)
    address public immutable v4Swap;      // HalcyonSwap (buybacks on v4 pools, stock buys through v4)
    address public immutable deployer;    // may wire the launchpad once, so a deploy is one script run
    address public mist;                  // HalcyonMist, the pool Mist rounds are sown into
    uint256 public platformPot;
    mapping(address => Coin) public coins;
    mapping(address => Branches) private _branches;
    mapping(address => uint256) public claimable;                       // ETH that could not be pushed (a receiver that reverts)
    mapping(address => mapping(address => uint256)) public claimableStock; // stock => holder => amount that could not be transferred
    mapping(address => bool) public stockAllowed;                       // the platform's list of tokenized stocks a module may buy
    mapping(address => bytes) public mistKeys;                          // holder => mist key (MIST_KEY_LENGTH bytes), or empty
    bool private _entered;

    event Registered(address indexed token, address indexed creator, uint8 module, uint8 pool, address stock);
    event ModuleSet(address indexed token, uint8 module, address stock);
    event CreatorSet(address indexed token, address indexed creator);
    event BranchesSet(address indexed token, address[] to, uint16[] bps);
    event Deposited(address indexed token, uint256 amount, uint256 platformShare, uint256 coinShare, uint8 module);
    event PaidHolders(address indexed token, uint256 total, uint256 count);
    event Burned(address indexed token, uint256 eth, uint256 tokens);
    event StockBought(address indexed token, address indexed stock, uint256 eth, uint256 amount);
    event StockPaid(address indexed token, address indexed stock, uint256 total, uint256 count, uint256 unclaimed);
    event StockClaimed(address indexed stock, address indexed to, uint256 amount);
    event DrawOpened(address indexed token, uint64 drawBlock, uint256 pot);
    event DrawPaid(address indexed token, address indexed winner, uint256 amount, uint64 drawBlock, bytes32 seed);
    event Claimed(address indexed to, uint256 amount);
    event PlatformWithdrawn(address indexed to, uint256 amount);
    event GardenerSet(address indexed gardener);
    event PlatformSet(address indexed platform);
    event Wired(address indexed launchpad, address locker, address v4Locker, address hook);
    event StockAllowed(address indexed stock, bool allowed);
    event MistKeySet(address indexed holder, bytes key);
    event PaidMist(address indexed token, uint256 total, uint256 count, uint32 batch);
    event MistSet(address indexed mist);

    modifier onlyPlatform() { require(msg.sender == platform, "platform"); _; }
    modifier onlyGardener() { require(msg.sender == gardener, "gardener"); _; }
    modifier nonReentrant() { require(!_entered, "reentrant"); _entered = true; _; _entered = false; }

    constructor(address platform_, address gardener_, address weth_, address swapRouter_, address v4Swap_) {
        require(platform_ != address(0) && gardener_ != address(0) && weth_ != address(0) && swapRouter_ != address(0), "zero");
        platform = platform_;
        gardener = gardener_;
        weth = weth_;
        swapRouter = swapRouter_;
        v4Swap = v4Swap_;
        deployer = msg.sender;
        emit PlatformSet(platform_);
        emit GardenerSet(gardener_);
    }

    /// @notice Set once, by the platform or the deployer: the launchpad that registers coins, the two lockers that deposit, the hook.
    function wire(address launchpad_, address locker_, address v4Locker_, address hook_) external {
        require(msg.sender == platform || msg.sender == deployer, "platform");
        require(launchpad == address(0), "wired");
        require(launchpad_ != address(0) && locker_ != address(0), "zero");
        launchpad = launchpad_;
        locker = locker_;
        v4Locker = v4Locker_;
        hook = hook_;
        emit Wired(launchpad_, locker_, v4Locker_, hook_);
    }

    function setGardener(address next) external onlyPlatform {
        require(next != address(0), "zero");
        gardener = next;
        emit GardenerSet(next);
    }

    function setPlatform(address next) external onlyPlatform {
        require(next != address(0), "zero");
        platform = next;
        emit PlatformSet(next);
    }

    function setStockAllowed(address stock, bool allowed) external onlyPlatform {
        stockAllowed[stock] = allowed;
        emit StockAllowed(stock, allowed);
    }

    /// @notice The same for a list in one transaction (the registry's routed stocks, say).
    function setStocksAllowed(address[] calldata stocks, bool allowed) external onlyPlatform {
        for (uint256 i = 0; i < stocks.length; i++) {
            stockAllowed[stocks[i]] = allowed;
            emit StockAllowed(stocks[i], allowed);
        }
    }

    /// @notice The mist pool, set once by the platform or the deployer (it is deployed after this contract, since it names it).
    function setMist(address next) external {
        require(msg.sender == platform || (msg.sender == deployer && mist == address(0)), "platform");
        require(next != address(0) && mist == address(0), "set");
        mist = next;
        emit MistSet(next);
    }

    /// @notice A holder registers the public half of their mist key: 64 bytes, two packed Baby Jubjub points (spending, viewing).
    /// From then on every Mist note for them is sown for that key. An empty key removes it (payouts in the open again).
    function setMistKey(bytes calldata key) external {
        require(key.length == 0 || key.length == MIST_KEY_LENGTH, "key");
        mistKeys[msg.sender] = key;
        emit MistKeySet(msg.sender, key);
    }

    /// @notice The launchpad registers a coin at launch with the module its creator chose (and the split, for the Split module).
    function register(address token, address creator, uint8 module, uint8 pool, address stock, address[] calldata splitTo, uint16[] calldata splitBps) external {
        require(msg.sender == launchpad, "launchpad");
        require(coins[token].creator == address(0), "registered");
        require(creator != address(0), "creator");
        require(pool == POOL_V3 || pool == POOL_V4, "pool");
        if (splitTo.length > 0) _setBranches(token, splitTo, splitBps);
        _checkModule(token, module, stock);
        coins[token] = Coin({ creator: creator, module: module, pool: pool, stock: stock, pot: 0, received: 0, paid: 0, stockHeld: 0, drawBlock: 0 });
        emit Registered(token, creator, module, pool, stock);
    }

    /// @notice The creator changes what the 80% becomes from here on (what already waits in the pot follows the new module too).
    function setModule(address token, uint8 module, address stock) external {
        Coin storage c = coins[token];
        require(msg.sender == c.creator, "creator");
        _checkModule(token, module, stock);
        c.module = module;
        c.stock = stock;
        c.drawBlock = 0;
        emit ModuleSet(token, module, stock);
    }

    /// @notice Branch module: the creator names up to eight addresses and their shares in basis points (they must sum to 10,000).
    function setBranches(address token, address[] calldata to, uint16[] calldata bps) external {
        require(msg.sender == coins[token].creator, "creator");
        _setBranches(token, to, bps);
    }

    function setCreator(address token, address next) external {
        Coin storage c = coins[token];
        require(msg.sender == c.creator && next != address(0), "creator");
        c.creator = next;
        emit CreatorSet(token, next);
    }

    function branches(address token) external view returns (address[] memory to, uint16[] memory bps) {
        Branches storage s = _branches[token];
        return (s.to, s.bps);
    }

    /// @notice A fee lands: from a locker (collected pool fees, as ETH) or from the launchpad.
    function deposit(address token) external payable nonReentrant {
        Coin storage c = coins[token];
        require(c.creator != address(0), "unknown coin");
        require(msg.sender == launchpad || msg.sender == locker || msg.sender == v4Locker, "source");
        uint256 p = msg.value * PLATFORM_BPS / 10_000;
        uint256 share = msg.value - p;
        platformPot += p;
        c.received += msg.value;
        if (c.module == MODULE_ROOTS) {
            c.paid += share;
            _push(c.creator, share);
        } else if (c.module == MODULE_BRANCH) {
            c.paid += share;
            Branches storage s = _branches[token];
            uint256 left = share;
            for (uint256 i = 0; i < s.to.length; i++) {
                uint256 part = i + 1 == s.to.length ? left : share * s.bps[i] / 10_000;
                left -= part;
                _push(s.to[i], part);
            }
        } else {
            c.pot += share;
        }
        emit Deposited(token, msg.value, p, share, c.module);
    }

    /// @notice Rain, Rings and Mist modules: the gardener pays the pot out to holders. Every recipient must hold the coin. (Under
    /// Mist this is how holders without a mist key are paid.)
    function payHolders(address token, address[] calldata to, uint256[] calldata amounts) external onlyGardener nonReentrant {
        Coin storage c = coins[token];
        require(c.module == MODULE_RAIN || c.module == MODULE_RINGS || c.module == MODULE_MIST, "module");
        require(to.length == amounts.length && to.length > 0, "lengths");
        uint256 total = 0;
        for (uint256 i = 0; i < to.length; i++) {
            require(IERC20Min(token).balanceOf(to[i]) > 0, "not a holder");
            total += amounts[i];
        }
        require(total <= c.pot, "pot");
        c.pot -= total;
        c.paid += total;
        for (uint256 i = 0; i < to.length; i++) {
            _push(to[i], amounts[i]);
        }
        emit PaidHolders(token, total, to.length);
    }

    /// @notice Mist module: the gardener sows a round into the mist pool: one note per holder and denomination, each a commitment
    /// made for that holder's mist key, announced with the ephemeral key and a view tag. The pool checks the denominations and the
    /// value, hashes the notes into its tree, and from then on only a proof from the holder's spending key can move the ETH.
    function payMist(address token, uint256[] calldata commits, uint256[] calldata denoms, bytes32[] calldata ephemerals, uint8[] calldata viewTags) external onlyGardener nonReentrant {
        Coin storage c = coins[token];
        require(c.module == MODULE_MIST, "module");
        require(mist != address(0), "no mist");
        require(denoms.length == commits.length && commits.length > 0, "lengths");
        uint256 total = 0;
        for (uint256 i = 0; i < denoms.length; i++) total += denoms[i];
        require(total <= c.pot, "pot");
        c.pot -= total;
        c.paid += total;
        uint32 batch = IHalcyonMistMin(mist).sow{value: total}(token, commits, denoms, ephemerals, viewTags);
        emit PaidMist(token, total, commits.length, batch);
    }

    /// @notice Prune module: the gardener buys the coin back with `eth` of the pot, through its own pool, and burns what it bought.
    function buyback(address token, uint256 eth, uint256 minOut) external onlyGardener nonReentrant {
        Coin storage c = coins[token];
        require(c.module == MODULE_PRUNE, "module");
        require(eth > 0 && eth <= c.pot, "pot");
        c.pot -= eth;
        c.paid += eth;
        uint256 before = IERC20Min(token).balanceOf(address(this));
        if (c.pool == POOL_V4) {
            require(v4Swap != address(0) && hook != address(0), "no v4");
            IHalcyonSwapMin(v4Swap).buy{value: eth}(poolKey(token), minOut, address(this), block.timestamp);
        } else {
            ISwapRouter02Min(swapRouter).exactInputSingle{value: eth}(ISwapRouter02Min.ExactInputSingleParams({
                tokenIn: weth, tokenOut: token, fee: V3_FEE, recipient: address(this), amountIn: eth, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
            }));
        }
        uint256 bought = IERC20Min(token).balanceOf(address(this)) - before;
        require(bought >= minOut, "min out");
        IHalcyonTokenMin(token).burn(bought);
        emit Burned(token, eth, bought);
    }

    /// @notice Harvest module: the gardener buys the coin's stock with `eth` of the pot through Uniswap v3 (`path` starts with WETH and ends with the stock).
    function buyStock(address token, uint256 eth, uint256 minOut, bytes calldata path) external onlyGardener nonReentrant {
        Coin storage c = coins[token];
        require(c.module == MODULE_HARVEST, "module");
        require(eth > 0 && eth <= c.pot, "pot");
        require(path.length >= 43 && _pathStart(path) == weth && _pathEnd(path) == c.stock, "path");
        c.pot -= eth;
        c.paid += eth;
        IWETH9(weth).deposit{value: eth}();
        IWETH9(weth).approve(swapRouter, eth);
        uint256 before = IERC20Min(c.stock).balanceOf(address(this));
        ISwapRouter02Min(swapRouter).exactInput(ISwapRouter02Min.ExactInputParams({ path: path, recipient: address(this), amountIn: eth, amountOutMinimum: minOut }));
        uint256 got = IERC20Min(c.stock).balanceOf(address(this)) - before;
        require(got >= minOut, "min out");
        c.stockHeld += got;
        emit StockBought(token, c.stock, eth, got);
    }

    /// @notice Harvest module: the same buy through Uniswap v4. `path` is one hop per pool, from ETH (`fromWeth` false, the pools
    /// v4 quotes in native ETH) or from WETH (true), and must end at the coin's stock. What the first pool could not take goes back
    /// into the pot.
    function buyStockV4(address token, uint256 eth, uint256 minOut, bool fromWeth, Hop[] calldata path) external onlyGardener nonReentrant {
        Coin storage c = coins[token];
        require(c.module == MODULE_HARVEST, "module");
        require(eth > 0 && eth <= c.pot, "pot");
        require(v4Swap != address(0), "no v4");
        require(path.length > 0 && path[path.length - 1].currency == c.stock, "path");
        c.pot -= eth;
        c.paid += eth;
        uint256 before = IERC20Min(c.stock).balanceOf(address(this));
        uint256 used;
        if (fromWeth) {
            IWETH9(weth).deposit{value: eth}();
            IWETH9(weth).approve(v4Swap, eth);
            (used, ) = IHalcyonSwapMin(v4Swap).swapPath(path, weth, eth, minOut, address(this), block.timestamp);
            if (used < eth) IWETH9(weth).withdraw(eth - used);
        } else {
            (used, ) = IHalcyonSwapMin(v4Swap).swapPath{value: eth}(path, address(0), eth, minOut, address(this), block.timestamp);
        }
        if (used < eth) {
            c.pot += eth - used;
            c.paid -= eth - used;
        }
        uint256 got = IERC20Min(c.stock).balanceOf(address(this)) - before;
        require(got >= minOut, "min out");
        c.stockHeld += got;
        emit StockBought(token, c.stock, used, got);
    }

    /// @notice Harvest module: the gardener pays the stock it holds for a coin out to holders, pro rata. A holder the stock's issuer
    /// will not let receive (a compliance block, a paused token) gets a claimable balance instead of blocking the batch.
    function payStock(address token, address[] calldata to, uint256[] calldata amounts) external onlyGardener nonReentrant {
        Coin storage c = coins[token];
        require(c.module == MODULE_HARVEST, "module");
        require(to.length == amounts.length && to.length > 0, "lengths");
        uint256 total = 0;
        for (uint256 i = 0; i < to.length; i++) {
            require(IERC20Min(token).balanceOf(to[i]) > 0, "not a holder");
            total += amounts[i];
        }
        require(total <= c.stockHeld, "stock held");
        c.stockHeld -= total;
        uint256 unclaimed = 0;
        for (uint256 i = 0; i < to.length; i++) {
            if (!_tryTransfer(c.stock, to[i], amounts[i])) {
                claimableStock[c.stock][to[i]] += amounts[i];
                unclaimed += amounts[i];
            }
        }
        emit StockPaid(token, c.stock, total, to.length, unclaimed);
    }

    /// @notice Clover module: the gardener opens a draw. The block `DRAW_DELAY` ahead is the one whose hash picks the winner.
    function openDraw(address token) external onlyGardener {
        Coin storage c = coins[token];
        require(c.module == MODULE_CLOVER, "module");
        require(c.pot > 0, "pot");
        c.drawBlock = uint64(block.number + DRAW_DELAY);
        emit DrawOpened(token, c.drawBlock, c.pot);
    }

    /// @notice Clover module: once the draw block has passed, the gardener pays the pot to the holder its hash drew (weighted by
    /// balance, over the holders at that block; the hash and the block are in the event so anyone can check the draw).
    function payDraw(address token, address winner) external onlyGardener nonReentrant {
        Coin storage c = coins[token];
        require(c.module == MODULE_CLOVER, "module");
        uint64 drawBlock = c.drawBlock;
        require(drawBlock != 0 && block.number > drawBlock, "no draw");
        require(block.number <= drawBlock + DRAW_WINDOW, "draw expired");
        bytes32 seed = blockhash(drawBlock);
        require(seed != bytes32(0), "no hash");
        require(IERC20Min(token).balanceOf(winner) > 0, "not a holder");
        uint256 amount = c.pot;
        c.pot = 0;
        c.paid += amount;
        c.drawBlock = 0;
        _push(winner, amount);
        emit DrawPaid(token, winner, amount, drawBlock, seed);
    }

    /// @notice ETH that could not be pushed to its owner waits here; the owner pulls it.
    function claim() external nonReentrant {
        uint256 a = claimable[msg.sender];
        require(a > 0, "nothing");
        claimable[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok, "send");
        emit Claimed(msg.sender, a);
    }

    /// @notice Stock that could not be transferred to its owner waits here; the owner pulls it (once the issuer lets them receive).
    function claimStock(address stock) external nonReentrant {
        uint256 a = claimableStock[stock][msg.sender];
        require(a > 0, "nothing");
        claimableStock[stock][msg.sender] = 0;
        require(IERC20Min(stock).transfer(msg.sender, a), "stock transfer");
        emit StockClaimed(stock, msg.sender, a);
    }

    function withdrawPlatform(address to, uint256 amount) external onlyPlatform nonReentrant {
        require(to != address(0) && amount <= platformPot, "amount");
        platformPot -= amount;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send");
        emit PlatformWithdrawn(to, amount);
    }

    /// @notice The Uniswap v4 pool key of a coin launched on v4: native ETH against the coin, dynamic fee, the Halcyon hook.
    function poolKey(address token) public view returns (PoolKey memory) {
        return PoolKey({ currency0: Currency.wrap(address(0)), currency1: Currency.wrap(token), fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: V4_TICK_SPACING, hooks: IHooks(hook) });
    }

    function _setBranches(address token, address[] calldata to, uint16[] calldata bps) internal {
        require(to.length > 0 && to.length <= MAX_BRANCHES && to.length == bps.length, "branches");
        uint256 sum = 0;
        for (uint256 i = 0; i < to.length; i++) {
            require(to[i] != address(0) && bps[i] > 0, "branch entry");
            sum += bps[i];
        }
        require(sum == 10_000, "branch sum");
        _branches[token] = Branches({ to: to, bps: bps });
        emit BranchesSet(token, to, bps);
    }

    function _checkModule(address token, uint8 module, address stock) internal view {
        require(module <= MODULE_MIST, "module");
        if (module == MODULE_HARVEST) {
            require(stock != address(0) && stockAllowed[stock], "stock");
        } else {
            require(stock == address(0), "stock");
        }
        if (module == MODULE_BRANCH) require(_branches[token].to.length > 0, "no branches");
    }

    /// @dev Push ETH with a bounded gas stipend; a receiver that refuses gets a claimable balance instead of blocking anyone else.
    function _push(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount, gas: 50_000}("");
        if (!ok) claimable[to] += amount;
    }

    /// @dev An ERC-20 transfer that reports failure instead of reverting (a revert, a false return, or no code).
    function _tryTransfer(address stock, address to, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        (bool ok, bytes memory ret) = stock.call(abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount));
        return ok && (ret.length == 0 ? stock.code.length > 0 : abi.decode(ret, (bool)));
    }

    function _pathStart(bytes calldata path) internal pure returns (address a) {
        a = address(bytes20(path[0:20]));
    }

    function _pathEnd(bytes calldata path) internal pure returns (address a) {
        a = address(bytes20(path[path.length - 20:]));
    }

    /// @dev Only deposits bring ETH in; a refund from a swap router, or WETH unwrapped after one, is the one other thing that may land here.
    receive() external payable {
        require(msg.sender == swapRouter || msg.sender == v4Swap || msg.sender == weth, "use deposit");
    }
}
