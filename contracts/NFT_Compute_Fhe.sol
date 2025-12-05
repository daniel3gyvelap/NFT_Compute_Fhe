pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract NftComputeFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 60; // Default 1 minute cooldown

    bool public paused = false;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 dataCount;
        euint32 encryptedSum;
    }

    uint256 public currentBatchId = 1;
    mapping(uint256 => Batch) public batches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event Paused(address account);
    event Unpaused(address account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, uint256 dataCount);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 sum);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) public onlyOwner {
        require(newOwner != address(0), "New owner is zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) public onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) public onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) public onlyOwner {
        require(newCooldownSeconds > 0, "Cooldown must be positive");
        emit CooldownSecondsSet(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function pause() public onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() public onlyOwner {
        require(paused, "Contract not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openBatch() public onlyOwner whenNotPaused {
        require(!batches[currentBatchId].isOpen, "Current batch is already open");
        batches[currentBatchId].isOpen = true;
        batches[currentBatchId].dataCount = 0;
        batches[currentBatchId].encryptedSum = FHE.asEuint32(0);
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() public onlyOwner whenNotPaused {
        require(batches[currentBatchId].isOpen, "Current batch is not open");
        batches[currentBatchId].isOpen = false;
        emit BatchClosed(currentBatchId);
        currentBatchId++;
    }

    function submitData(euint32 encryptedValue) public onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batches[currentBatchId].isOpen) {
            revert BatchNotOpen();
        }
        if (!encryptedValue.isInitialized()) {
            revert("Encrypted value not initialized");
        }

        lastSubmissionTime[msg.sender] = block.timestamp;

        batches[currentBatchId].dataCount++;
        batches[currentBatchId].encryptedSum = FHE.add(
            batches[currentBatchId].encryptedSum,
            encryptedValue
        );

        emit DataSubmitted(msg.sender, currentBatchId, batches[currentBatchId].dataCount);
    }

    function requestBatchSumDecryption(uint256 batchId) public whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batchId == 0 || batchId >= currentBatchId || !batches[batchId].isOpen) {
            revert InvalidBatch();
        }
        if (batches[batchId].dataCount == 0) {
            revert("No data in batch");
        }
        if (!batches[batchId].encryptedSum.isInitialized()) {
            revert("Encrypted sum not initialized");
        }

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 memory sumToDecrypt = batches[batchId].encryptedSum;
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(sumToDecrypt);

        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        uint256 batchId = decryptionContexts[requestId].batchId;
        if (batchId == 0 || batchId >= currentBatchId) {
            revert InvalidBatch();
        }

        // Rebuild ciphertexts for state verification
        euint32 memory sumToDecrypt = batches[batchId].encryptedSum;
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(sumToDecrypt);

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        uint32 sum = abi.decode(cleartexts, (uint32));
        decryptionContexts[requestId].processed = true;

        emit DecryptionCompleted(requestId, batchId, sum);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage e) internal {
        if (!e.isInitialized()) {
            e = FHE.asEuint32(0);
        }
    }
}