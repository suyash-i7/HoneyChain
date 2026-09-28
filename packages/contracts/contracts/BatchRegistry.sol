// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract BatchRegistry {
    struct BatchRecord {
        bytes32 dataDigest;
        address recordedBy;
        uint64 recordedAt;
    }

    mapping(string => BatchRecord) private batches;

    event BatchAnchored(
        string indexed batchCode,
        bytes32 dataDigest,
        address indexed recordedBy,
        uint64 recordedAt
    );

    error BatchAlreadyAnchored(string batchCode);
    error InvalidBatchCode();
    error InvalidDigest();

    function anchorBatch(string calldata batchCode, bytes32 dataDigest) external {
        if (bytes(batchCode).length == 0) revert InvalidBatchCode();
        if (dataDigest == bytes32(0)) revert InvalidDigest();
        if (batches[batchCode].recordedAt != 0) revert BatchAlreadyAnchored(batchCode);

        uint64 recordedAt = uint64(block.timestamp);
        batches[batchCode] = BatchRecord(dataDigest, msg.sender, recordedAt);
        emit BatchAnchored(batchCode, dataDigest, msg.sender, recordedAt);
    }

    function getBatch(string calldata batchCode)
        external
        view
        returns (bytes32 dataDigest, address recordedBy, uint64 recordedAt)
    {
        BatchRecord memory record = batches[batchCode];
        return (record.dataDigest, record.recordedBy, record.recordedAt);
    }
}