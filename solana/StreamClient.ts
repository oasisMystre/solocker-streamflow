// Latest version of the SDK that does not use Anchor. It supports raw instructions.

import BN from "bn.js";
import { Buffer } from "buffer";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
  TransactionInstruction,
  Transaction,
  Commitment,
  ConnectionConfig,
} from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import * as borsh from "borsh";

import {
  Account,
  MetadataRecipientHashMap,
  Contract,
  BatchItem,
  BatchItemSuccess,
  BatchItemError,
  ICreateStreamSolanaExt,
  IInteractStreamSolanaExt,
  ITopUpStreamSolanaExt,
  CheckAssociatedTokenAccountsData,
} from "./types";
import {
  ata,
  decodeStream,
  extractSolanaErrorCode,
  getProgramAccounts,
  sendAndConfirmStreamRawTransaction,
  signAllTransactionWithRecipients,
  signAndExecuteTransaction,
} from "./utils";
import {
  PROGRAM_ID,
  STREAMFLOW_TREASURY_PUBLIC_KEY,
  STREAM_STRUCT_OFFSET_RECIPIENT,
  STREAM_STRUCT_OFFSET_SENDER,
  TX_FINALITY_CONFIRMED,
  WITHDRAWOR_PUBLIC_KEY,
  FEE_ORACLE_PUBLIC_KEY,
  DEFAULT_STREAMFLOW_FEE,
  PARTNER_ORACLE_PROGRAM_ID,
  FEES_METADATA_SEED,
  PARTNERS_SCHEMA,
} from "./constants";
import {
  withdrawStreamInstruction,
  cancelStreamInstruction,
  transferStreamInstruction,
  topupStreamInstruction,
  createStreamInstruction,
  createUncheckedStreamInstruction,
  prepareWrappedAccount,
  updateStreamInstruction,
} from "./instructions";
import {
  ICancelData,
  ICluster,
  ICreateMultipleStreamData,
  ICreateResult,
  ICreateStreamData,
  IGetAllData,
  IGetFeesData,
  IGetOneData,
  IFees,
  IMultiTransactionResult,
  IRecipient,
  IStreamConfig,
  ITopUpData,
  ITransactionResult,
  ITransferData,
  IUpdateData,
  IWithdrawData,
  StreamDirection,
  StreamType,
  Stream,
  ICreateMultiError,
} from "../common/types";
import { BaseStreamClient } from "../common/BaseStreamClient";
import { IPartnerLayout } from "./instructionTypes";

const METADATA_ACC_SIZE = 1104;

export default class SolanaStreamClient extends BaseStreamClient {
  private connection: Connection;

  private programId: PublicKey;

  private commitment: Commitment | ConnectionConfig;

  /**
   * Create Stream instance
   */
  constructor(
    clusterUrl: string,
    cluster: ICluster = ICluster.Mainnet,
    commitment: Commitment | ConnectionConfig = "confirmed",
    programId = ""
  ) {
    super();
    this.commitment = commitment;
    this.connection = new Connection(clusterUrl, this.commitment);
    this.programId =
      programId !== "" ? new PublicKey(programId) : new PublicKey(PROGRAM_ID[cluster]);
  }

  public getConnection(): Connection {
    return this.connection;
  }

  public getProgramId(): string {
    return this.programId.toBase58();
  }

  /**
   * Creates a new stream/vesting contract.
   * All fees are paid by sender (escrow metadata account rent, escrow token account rent, recipient's associated token account rent, Streamflow's service fee).
   */
  public async create(
    {
      recipient,
      tokenId: mint,
      start,
      amount: depositedAmount,
      period,
      cliff,
      cliffAmount,
      amountPerPeriod,
      name,
      canTopup,
      cancelableBySender,
      cancelableByRecipient,
      transferableBySender,
      transferableByRecipient,
      automaticWithdrawal = false,
      withdrawalFrequency = 0,
      partner,
      customInstructions=[],
    }: ICreateStreamData & { customInstructions?: TransactionInstruction[], },
    { sender, metadataPubKeys, isNative = false }: ICreateStreamSolanaExt
  ): Promise<ICreateResult> {
    if (!sender.publicKey) {
      throw new Error("Sender's PublicKey is not available, check passed wallet adapter!");
    }

    const ixs: TransactionInstruction[] = customInstructions;
    const mintPublicKey = isNative ? NATIVE_MINT : new PublicKey(mint);
    const recipientPublicKey = new PublicKey(recipient);

    const { metadata, metadataPubKey } = this.getOrCreateStreamMetadata(metadataPubKeys);
    const [escrowTokens] = PublicKey.findProgramAddressSync(
      [Buffer.from("strm"), metadataPubKey.toBuffer()],
      this.programId
    );

    const senderTokens = await ata(mintPublicKey, sender.publicKey);
    const recipientTokens = await ata(mintPublicKey, recipientPublicKey);
    const streamflowTreasuryTokens = await ata(mintPublicKey, STREAMFLOW_TREASURY_PUBLIC_KEY);

    const partnerPublicKey = partner ? new PublicKey(partner) : STREAMFLOW_TREASURY_PUBLIC_KEY;

    const partnerTokens = await ata(mintPublicKey, partnerPublicKey);

    const nativeInstructions = isNative
      ? await prepareWrappedAccount(this.connection, sender.publicKey, depositedAmount)
      : ([] as TransactionInstruction[]);

    ixs.push(
      createStreamInstruction(
        {
          start: new BN(start),
          depositedAmount,
          period: new BN(period),
          amountPerPeriod,
          cliff: new BN(cliff),
          cliffAmount,
          cancelableBySender,
          cancelableByRecipient,
          automaticWithdrawal,
          transferableBySender,
          transferableByRecipient,
          canTopup,
          name,
          withdrawFrequency: new BN(automaticWithdrawal ? withdrawalFrequency : period),
        },
        this.programId,
        {
          sender: sender.publicKey,
          senderTokens,
          recipient: new PublicKey(recipient),
          metadata: metadataPubKey,
          escrowTokens,
          recipientTokens,
          streamflowTreasury: STREAMFLOW_TREASURY_PUBLIC_KEY,
          streamflowTreasuryTokens: streamflowTreasuryTokens,
          partner: partnerPublicKey,
          partnerTokens: partnerTokens,
          mint: new PublicKey(mint),
          feeOracle: FEE_ORACLE_PUBLIC_KEY,
          rent: SYSVAR_RENT_PUBKEY,
          timelockProgram: this.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          withdrawor: WITHDRAWOR_PUBLIC_KEY,
          systemProgram: SystemProgram.programId,
        }
      )
    );

    const commitment =
      typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;

    const hash = await this.connection.getLatestBlockhash(commitment);
    const tx = new Transaction({
      feePayer: sender.publicKey,
      blockhash: hash.blockhash,
      lastValidBlockHeight: hash.lastValidBlockHeight,
    }).add(...nativeInstructions, ...ixs);

    if (metadata) {
      tx.partialSign(metadata);
    }

    const signature = await signAndExecuteTransaction(this.connection, sender, tx, hash);

    return { ixs, txId: signature, metadataId: metadataPubKey.toBase58() };
  }

  /**
   * Creates a new stream/vesting contract using unchecked instruction.
   *
   * Unchecked instruction differs from the regular in:
   * - does not check for initialized associated token account (wallets with no control over their ATA should not be used
   * as sender/recipient/partner or there are risks of funds being locked in the contract)
   * - initialized contract PDA off chain
   *
   * If you are not sure if you should use create or create_unchecked, go for create to be safer.
   */
  public async createUnchecked(
    {
      recipient,
      tokenId: mint,
      start,
      amount: depositedAmount,
      period,
      cliff,
      cliffAmount,
      amountPerPeriod,
      name,
      canTopup,
      cancelableBySender,
      cancelableByRecipient,
      transferableBySender,
      transferableByRecipient,
      automaticWithdrawal = false,
      withdrawalFrequency = 0,
      partner,
      customInstructions=[],
    }: ICreateStreamData & { customInstructions?: TransactionInstruction[], },
    { sender, metadataPubKeys, isNative = false }: ICreateStreamSolanaExt
  ): Promise<ICreateResult> {
    if (!sender.publicKey) {
      throw new Error("Sender's PublicKey is not available, check passed wallet adapter!");
    }

    const mintPublicKey = new PublicKey(mint);
    const recipientPublicKey = new PublicKey(recipient);
    const { metadata, metadataPubKey } = this.getOrCreateStreamMetadata(metadataPubKeys);

    const rentToExempt = await this.connection.getMinimumBalanceForRentExemption(METADATA_ACC_SIZE);
    const createMetadataInstruction = SystemProgram.createAccount({
      programId: this.programId,
      space: METADATA_ACC_SIZE,
      lamports: rentToExempt,
      fromPubkey: sender?.publicKey,
      newAccountPubkey: metadataPubKey,
    });

    const [escrowTokens] = PublicKey.findProgramAddressSync(
      [Buffer.from("strm"), metadataPubKey.toBuffer()],
      this.programId
    );

    const senderTokens = await ata(mintPublicKey, sender.publicKey);

    const partnerPublicKey = partner ? new PublicKey(partner) : STREAMFLOW_TREASURY_PUBLIC_KEY;

    const nativeInstructions = isNative
      ? await prepareWrappedAccount(this.connection, sender.publicKey, depositedAmount)
      : ([] as TransactionInstruction[]);

    const createInstruction = createUncheckedStreamInstruction(
      {
        start: new BN(start),
        depositedAmount,
        period: new BN(period),
        amountPerPeriod,
        cliff: new BN(cliff),
        cliffAmount,
        cancelableBySender,
        cancelableByRecipient,
        automaticWithdrawal,
        transferableBySender,
        transferableByRecipient,
        canTopup,
        name,
        withdrawFrequency: new BN(automaticWithdrawal ? withdrawalFrequency : period),
        recipient: recipientPublicKey,
        partner: partnerPublicKey,
      },
      this.programId,
      {
        sender: sender.publicKey,
        senderTokens,
        metadata: metadataPubKey,
        escrowTokens,
        mint: new PublicKey(mint),
        feeOracle: FEE_ORACLE_PUBLIC_KEY,
        rent: SYSVAR_RENT_PUBKEY,
        timelockProgram: this.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        withdrawor: WITHDRAWOR_PUBLIC_KEY,
        systemProgram: SystemProgram.programId,
      }
    );
    const commitment =
      typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;
    const ixs: TransactionInstruction[] = [createMetadataInstruction, createInstruction, ...customInstructions];
    const hash = await this.connection.getLatestBlockhash(commitment);
    const tx = new Transaction({
      feePayer: sender.publicKey,
      blockhash: hash.blockhash,
      lastValidBlockHeight: hash.lastValidBlockHeight,
    }).add(...nativeInstructions, ...ixs);

    if (metadata) {
      tx.partialSign(metadata);
    }

    const signature = await signAndExecuteTransaction(this.connection, sender, tx, hash);

    return { ixs, txId: signature, metadataId: metadataPubKey.toBase58() };
  }

  /**
   * Creates multiple stream/vesting contracts.
   * All fees are paid by sender (escrow metadata account rent, escrow token account rent, recipient's associated token account rent, Streamflow's service fee).
   */
  public async createMultiple(
    data: ICreateMultipleStreamData,
    { sender, metadataPubKeys, isNative = false }: ICreateStreamSolanaExt
  ): Promise<IMultiTransactionResult> {
    const { recipients } = data;

    if (!sender.publicKey) {
      throw new Error("Sender's PublicKey is not available, check passed wallet adapter!");
    }

    const metadatas: string[] = [];
    const metadataToRecipient: MetadataRecipientHashMap = {};
    const errors: ICreateMultiError[] = [];
    const signatures: string[] = [];
    const batch: BatchItem[] = [];
    metadataPubKeys = metadataPubKeys || [];

    for (let i = 0; i < recipients.length; i++) {
      const recipientData = recipients[i];
      const { tx, metadataPubKey } = await this.prepareStreamTransaction(recipientData, data, {
        sender,
        metadataPubKeys: metadataPubKeys[i] ? [metadataPubKeys[i]] : undefined,
      });

      metadataToRecipient[metadataPubKey.toBase58()] = recipientData;

      metadatas.push(metadataPubKey.toBase58());
      batch.push({ tx, recipient: recipientData.recipient });
    }

    if (isNative) {
      const totalDepositedAmount = recipients.reduce(
        (acc, recipient) => recipient.amount.add(acc),
        new BN(0)
      );
      const nativeInstructions = await prepareWrappedAccount(
        this.connection,
        sender.publicKey,
        totalDepositedAmount
      );

      const commitment =
        typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;
      const hash = await this.connection.getLatestBlockhash(commitment);
      const prepareTransaction = new Transaction({
        feePayer: sender.publicKey,
        blockhash: hash.blockhash,
        lastValidBlockHeight: hash.lastValidBlockHeight,
      }).add(...nativeInstructions);

      batch.push({ tx: prepareTransaction, recipient: sender.publicKey.toBase58() });
    }

    const signedBatch: BatchItem[] = await signAllTransactionWithRecipients(sender, batch);
    signedBatch.forEach((item, index) => {
      item.tx.lastValidBlockHeight = batch[index].tx.lastValidBlockHeight;
    });

    if (isNative) {
      const prepareTx = signedBatch.pop();
      await sendAndConfirmStreamRawTransaction(this.connection, prepareTx!);
    }

    const responses: PromiseSettledResult<BatchItem>[] = [];
    if (metadataPubKeys.length > 0) {
      //if metadata pub keys were passed we should execute transaction sequentially
      //ephemeral signer need to be used first before proceeding with the next
      for (const batchTx of signedBatch) {
        responses.push(
          ...(await Promise.allSettled([
            sendAndConfirmStreamRawTransaction(this.connection, batchTx),
          ]))
        );
      }
    } else {
      //send all transactions in parallel and wait for them to settle.
      //it allows to speed up the process of sending transactions
      //we then filter all promise responses and handle failed transactions
      const batchTransactionsCalls = signedBatch.map((el) =>
        sendAndConfirmStreamRawTransaction(this.connection, el)
      );
      responses.push(...(await Promise.allSettled(batchTransactionsCalls)));
    }

    const successes = responses
      .filter((el): el is PromiseFulfilledResult<BatchItemSuccess> => el.status === "fulfilled")
      .map((el) => el.value);
    signatures.push(...successes.map((el) => el.signature));

    const failures = responses
      .filter((el): el is PromiseRejectedResult => el.status === "rejected")
      .map((el) => ({
        ...(el.reason as BatchItemError),
        contractErrorCode: this.extractErrorCode(el.reason.error) || undefined,
      }));
    errors.push(...failures);

    return { txs: signatures, metadatas, metadataToRecipient, errors };
  }

  /**
   * Attempts withdrawing from the specified stream.
   */
  public async withdraw(
    { id, amount }: IWithdrawData,
    { invoker, checkTokenAccounts }: IInteractStreamSolanaExt
  ): Promise<ITransactionResult> {
    if (!invoker.publicKey) {
      throw new Error("Invoker's PublicKey is not available, check passed wallet adapter!");
    }

    const ixs: TransactionInstruction[] = [];
    const streamPublicKey = new PublicKey(id);

    const escrow = await this.connection.getAccountInfo(streamPublicKey);
    if (!escrow?.data) {
      throw new Error("Couldn't get account info");
    }

    const data = decodeStream(escrow.data);

    const streamflowTreasuryTokens = await ata(data.mint, STREAMFLOW_TREASURY_PUBLIC_KEY);
    const partnerTokens = await ata(data.mint, data.partner);
    await this.checkAssociatedTokenAccounts(data, { invoker, checkTokenAccounts }, ixs);

    ixs.push(
      withdrawStreamInstruction(amount, this.programId, {
        authority: invoker.publicKey,
        recipient: invoker.publicKey,
        recipientTokens: data.recipientTokens,
        metadata: streamPublicKey,
        escrowTokens: data.escrowTokens,
        streamflowTreasury: STREAMFLOW_TREASURY_PUBLIC_KEY,
        streamflowTreasuryTokens,
        partner: data.partner,
        partnerTokens,
        mint: data.mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
    );

    const commitment =
      typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;
    const hash = await this.connection.getLatestBlockhash(commitment);
    const tx = new Transaction({
      feePayer: invoker.publicKey,
      blockhash: hash.blockhash,
      lastValidBlockHeight: hash.lastValidBlockHeight,
    }).add(...ixs);

    const signature = await signAndExecuteTransaction(this.connection, invoker, tx, hash);

    return { ixs, txId: signature };
  }

  /**
   * Attempts canceling the specified stream.
   */
  public async cancel(
    { id }: ICancelData,
    { invoker, checkTokenAccounts }: IInteractStreamSolanaExt
  ): Promise<ITransactionResult> {
    if (!invoker.publicKey) {
      throw new Error("Invoker's PublicKey is not available, check passed wallet adapter!");
    }

    const streamPublicKey = new PublicKey(id);
    const escrowAcc = await this.connection.getAccountInfo(streamPublicKey);
    if (!escrowAcc?.data) {
      throw new Error("Couldn't get account info");
    }

    const data = decodeStream(escrowAcc?.data);

    const streamflowTreasuryTokens = await ata(data.mint, STREAMFLOW_TREASURY_PUBLIC_KEY);
    const partnerTokens = await ata(data.mint, data.partner);

    const ixs: TransactionInstruction[] = [];
    await this.checkAssociatedTokenAccounts(data, { invoker, checkTokenAccounts }, ixs);

    ixs.push(
      cancelStreamInstruction(this.programId, {
        authority: invoker.publicKey,
        sender: data.sender,
        senderTokens: data.senderTokens,
        recipient: data.recipient,
        recipientTokens: data.recipientTokens,
        metadata: streamPublicKey,
        escrowTokens: data.escrowTokens,
        streamflowTreasury: STREAMFLOW_TREASURY_PUBLIC_KEY,
        streamflowTreasuryTokens: streamflowTreasuryTokens,
        partner: data.partner,
        partnerTokens,
        mint: data.mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
    );

    const commitment =
      typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;

    const hash = await this.connection.getLatestBlockhash(commitment);
    const tx = new Transaction({
      feePayer: invoker.publicKey,
      blockhash: hash.blockhash,
      lastValidBlockHeight: hash.lastValidBlockHeight,
    }).add(...ixs);

    const signature = await signAndExecuteTransaction(this.connection, invoker, tx, hash);

    return { ixs, txId: signature };
  }

  /**
   * Attempts changing the stream/vesting contract's recipient (effectively transferring the stream/vesting contract).
   * Potential associated token account rent fee (to make it rent-exempt) is paid by the transaction initiator.
   */
  public async transfer(
    { id, newRecipient: newRecipientString }: ITransferData,
    { invoker }: IInteractStreamSolanaExt
  ): Promise<ITransactionResult> {
    if (!invoker.publicKey) {
      throw new Error("Invoker's PublicKey is not available, check passed wallet adapter!");
    }

    const ixs: TransactionInstruction[] = [];
    const stream = new PublicKey(id);
    const newRecipient = new PublicKey(newRecipientString);
    const escrow = await this.connection.getAccountInfo(stream);
    if (!escrow?.data) {
      throw new Error("Couldn't get account info");
    }
    const { mint } = decodeStream(escrow?.data);

    const newRecipientTokens = await ata(mint, newRecipient);

    ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 100001 }));
    ixs.push(
      transferStreamInstruction(this.programId, {
        authority: invoker.publicKey,
        newRecipient,
        newRecipientTokens,
        metadata: stream,
        mint,
        rent: SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
    );

    const commitment =
      typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;
    const hash = await this.connection.getLatestBlockhash(commitment);

    const tx = new Transaction({
      feePayer: invoker.publicKey,
      blockhash: hash.blockhash,
      lastValidBlockHeight: hash.lastValidBlockHeight,
    }).add(...ixs);

    const signature = await signAndExecuteTransaction(this.connection, invoker, tx, hash);

    return { ixs, txId: signature };
  }

  /**
   * Tops up stream account with specified amount.
   */
  public async topup(
    { id, amount }: ITopUpData,
    { invoker, isNative }: ITopUpStreamSolanaExt
  ): Promise<ITransactionResult> {
    if (!invoker.publicKey) {
      throw new Error("Invoker's PublicKey is not available, check passed wallet adapter!");
    }

    const ixs: TransactionInstruction[] = [];
    const streamPublicKey = new PublicKey(id);
    const escrow = await this.connection.getAccountInfo(streamPublicKey);
    if (!escrow?.data) {
      throw new Error("Couldn't get account info");
    }
    const { mint, partner, senderTokens, escrowTokens } = decodeStream(escrow?.data);

    const streamflowTreasuryTokens = await ata(mint, STREAMFLOW_TREASURY_PUBLIC_KEY);
    const partnerTokens = await ata(mint, partner);

    const nativeInstructions = isNative
      ? await prepareWrappedAccount(this.connection, invoker.publicKey, amount)
      : ([] as TransactionInstruction[]);

    ixs.push(
      topupStreamInstruction(amount, this.programId, {
        sender: invoker.publicKey,
        senderTokens,
        metadata: streamPublicKey,
        escrowTokens,
        streamflowTreasury: STREAMFLOW_TREASURY_PUBLIC_KEY,
        streamflowTreasuryTokens: streamflowTreasuryTokens,
        partner: partner,
        partnerTokens: partnerTokens,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        withdrawor: WITHDRAWOR_PUBLIC_KEY,
        systemProgram: SystemProgram.programId,
      })
    );

    const commitment =
      typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;
    const hash = await this.connection.getLatestBlockhash(commitment);
    const tx = new Transaction({
      feePayer: invoker.publicKey,
      blockhash: hash.blockhash,
      lastValidBlockHeight: hash.lastValidBlockHeight,
    }).add(...nativeInstructions, ...ixs);

    const signature = await signAndExecuteTransaction(this.connection, invoker, tx, hash);

    return { ixs, txId: signature };
  }

  /**
   * Fetch stream data by its id (address).
   */
  public async getOne({ id }: IGetOneData): Promise<Stream> {
    const escrow = await this.connection.getAccountInfo(new PublicKey(id), TX_FINALITY_CONFIRMED);
    if (!escrow?.data) {
      throw new Error("Couldn't get account info.");
    }

    return new Contract(decodeStream(escrow?.data));
  }

  /**
   * Fetch streams/contracts by providing direction.
   * Streams are sorted by start time in ascending order.
   */
  public async get({
    address,
    type = StreamType.All,
    direction = StreamDirection.All,
  }: IGetAllData): Promise<[string, Stream][]> {
    const publicKey = new PublicKey(address);
    let accounts: Account[] = [];
    //todo: we need to be smart with our layout so we minimize rpc calls to the chain
    if (direction === "all") {
      const outgoingAccounts = await getProgramAccounts(
        this.connection,
        publicKey,
        STREAM_STRUCT_OFFSET_SENDER,
        this.programId
      );
      const incomingAccounts = await getProgramAccounts(
        this.connection,
        publicKey,
        STREAM_STRUCT_OFFSET_RECIPIENT,
        this.programId
      );
      accounts = [...outgoingAccounts, ...incomingAccounts];
    } else {
      const offset =
        direction === "outgoing" ? STREAM_STRUCT_OFFSET_SENDER : STREAM_STRUCT_OFFSET_RECIPIENT;
      accounts = await getProgramAccounts(this.connection, publicKey, offset, this.programId);
    }

    let streams: Record<string, Contract> = {};

    accounts.forEach((account) => {
      const decoded = new Contract(decodeStream(account.account.data));
      streams = { ...streams, [account.pubkey.toBase58()]: decoded };
    });

    const sortedStreams = Object.entries(streams).sort(
      ([, stream1], [, stream2]) => stream2.start - stream1.start
    );

    if (type === "all") return sortedStreams;

    return sortedStreams.filter((stream) => stream[1].type === type);
  }

  /**
   * Attempts updating the stream auto withdrawal params and amount per period
   */
  public async update(
    data: IUpdateData,
    { invoker }: IInteractStreamSolanaExt
  ): Promise<ITransactionResult> {
    if (!invoker.publicKey) {
      throw new Error("Invoker's PublicKey is not available, check passed wallet adapter!");
    }

    const streamPublicKey = new PublicKey(data.id);
    const escrow = await this.connection.getAccountInfo(streamPublicKey);

    if (!escrow) {
      throw new Error("Couldn't get account info");
    }

    const updateIx = updateStreamInstruction(data, this.programId, {
      authority: invoker.publicKey,
      metadata: streamPublicKey,
      withdrawor: WITHDRAWOR_PUBLIC_KEY,
      systemProgram: SystemProgram.programId,
    });
    const commitment =
      typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;
    const hash = await this.connection.getLatestBlockhash(commitment);

    const tx = new Transaction({
      feePayer: invoker.publicKey,
      blockhash: hash.blockhash,
      lastValidBlockHeight: hash.lastValidBlockHeight,
    }).add(updateIx);

    const signature = await signAndExecuteTransaction(this.connection, invoker, tx, hash);

    return {
      ixs: [updateIx],
      txId: signature,
    };
  }

  public async getFees({ address }: IGetFeesData): Promise<IFees | null> {
    const [metadataPubKey] = PublicKey.findProgramAddressSync(
      [Buffer.from(FEES_METADATA_SEED)],
      new PublicKey(PARTNER_ORACLE_PROGRAM_ID)
    );
    const data = await this.connection.getAccountInfo(metadataPubKey);
    if (!data) {
      return null;
    }
    const partners = borsh.deserialize(PARTNERS_SCHEMA, data!.data) as unknown as IPartnerLayout[];
    const filteredPartners = partners.filter(
      (item) => new PublicKey(item.pubkey).toString() === address
    );
    if (filteredPartners.length === 0) {
      return null;
    }
    return {
      streamflowFee: Number(filteredPartners[0].strm_fee.toFixed(4)),
      partnerFee: Number(filteredPartners[0].partner_fee.toFixed(4)),
    };
  }

  public async getDefaultStreamflowFee(): Promise<number> {
    return DEFAULT_STREAMFLOW_FEE;
  }

  public extractErrorCode(err: Error): string | null {
    return extractSolanaErrorCode(err.toString() ?? "Unknown error!");
  }

  /**
   * Forms instructions from params, creates a raw transaction and fetch recent blockhash.
   */
  private async prepareStreamTransaction(
    recipient: IRecipient,
    streamParams: IStreamConfig,
    solanaExtendedConfig: ICreateStreamSolanaExt
  ) {
    const {
      tokenId: mint,
      start,
      period,
      cliff,
      canTopup,
      cancelableBySender,
      cancelableByRecipient,
      transferableBySender,
      transferableByRecipient,
      automaticWithdrawal = false,
      withdrawalFrequency = 0,
      partner,
    } = streamParams;

    const { sender, metadataPubKeys } = solanaExtendedConfig;

    if (!sender.publicKey) {
      throw new Error("Sender's PublicKey is not available, check passed wallet adapter!");
    }

    const ixs: TransactionInstruction[] = [];
    const commitment =
      typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;
    const recipientPublicKey = new PublicKey(recipient.recipient);
    const mintPublicKey = new PublicKey(mint);
    const { metadata, metadataPubKey } = this.getOrCreateStreamMetadata(metadataPubKeys);
    const [escrowTokens] = PublicKey.findProgramAddressSync(
      [Buffer.from("strm"), metadataPubKey.toBuffer()],
      this.programId
    );

    const senderTokens = await ata(mintPublicKey, sender.publicKey);
    const recipientTokens = await ata(mintPublicKey, recipientPublicKey);
    const streamflowTreasuryTokens = await ata(mintPublicKey, STREAMFLOW_TREASURY_PUBLIC_KEY);

    const partnerPublicKey = partner ? new PublicKey(partner) : STREAMFLOW_TREASURY_PUBLIC_KEY;

    const partnerTokens = await ata(mintPublicKey, partnerPublicKey);

    ixs.push(
      createStreamInstruction(
        {
          start: new BN(start),
          depositedAmount: recipient.amount,
          period: new BN(period),
          amountPerPeriod: recipient.amountPerPeriod,
          cliff: new BN(cliff),
          cliffAmount: recipient.cliffAmount,
          cancelableBySender,
          cancelableByRecipient,
          automaticWithdrawal,
          transferableBySender,
          transferableByRecipient,
          canTopup,
          name: recipient.name,
          withdrawFrequency: new BN(automaticWithdrawal ? withdrawalFrequency : period),
        },
        this.programId,
        {
          sender: sender.publicKey,
          senderTokens,
          recipient: new PublicKey(recipient.recipient),
          metadata: metadataPubKey,
          escrowTokens,
          recipientTokens,
          streamflowTreasury: STREAMFLOW_TREASURY_PUBLIC_KEY,
          streamflowTreasuryTokens: streamflowTreasuryTokens,
          partner: partnerPublicKey,
          partnerTokens: partnerTokens,
          mint: new PublicKey(mint),
          feeOracle: FEE_ORACLE_PUBLIC_KEY,
          rent: SYSVAR_RENT_PUBKEY,
          timelockProgram: this.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          withdrawor: WITHDRAWOR_PUBLIC_KEY,
          systemProgram: SystemProgram.programId,
        }
      )
    );
    const hash = await this.connection.getLatestBlockhash(commitment);
    const tx = new Transaction({
      feePayer: sender.publicKey,
      blockhash: hash.blockhash,
      lastValidBlockHeight: hash.lastValidBlockHeight,
    }).add(...ixs);
    if (metadata) {
      tx.partialSign(metadata);
    }
    return { tx, metadataPubKey };
  }

  /**
   * Utility function that checks whether associated token accounts still exist and adds instructions to add them if not
   */
  private async checkAssociatedTokenAccounts(
    data: CheckAssociatedTokenAccountsData,
    { invoker, checkTokenAccounts }: IInteractStreamSolanaExt,
    ixs: TransactionInstruction[]
  ) {
    if (!checkTokenAccounts) {
      return;
    }
    const checkedKeys: Set<string> = new Set();
    // TODO: optimize fetching and maps/arrays
    const accountArrays = [
      [data.sender, data.senderTokens],
      [data.recipient, data.recipientTokens],
      [data.partner, data.partnerTokens],
      [data.streamflowTreasury, data.streamflowTreasuryTokens],
    ].filter((value) => {
      if (checkedKeys.has(value[1].toBase58())) {
        return false;
      }
      checkedKeys.add(value[1].toBase58());
      return true;
    });
    const response = await this.connection.getMultipleAccountsInfo(
      accountArrays.map((item) => item[1])
    );
    for (let i = 0; i < response.length; i++) {
      if (!response[i]) {
        ixs.push(
          createAssociatedTokenAccountInstruction(
            invoker.publicKey!,
            accountArrays[i][1],
            accountArrays[i][0],
            data.mint
          )
        );
      }
    }
  }

  /**
   * Utility function to generate metadata for a Contract or return existing Pubkey
   */
  private getOrCreateStreamMetadata(metadataPubKeys?: PublicKey[]) {
    let metadata;
    let metadataPubKey;

    if (!metadataPubKeys) {
      metadata = Keypair.generate();
      metadataPubKey = metadata.publicKey;
    } else {
      metadataPubKey = metadataPubKeys[0];
    }

    return { metadata, metadataPubKey };
  }
}
