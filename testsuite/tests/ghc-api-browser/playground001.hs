module Playground
  ( myMain,
    terminalInput,
    terminalEOF,
    interrupt,
  )
where

import Control.Concurrent
import Control.Exception
import Control.Monad
import qualified Data.ByteString as BS
import Data.Coerce
import Data.IORef
import Data.Maybe
import qualified Data.Text as Text
import qualified Data.Text.Encoding as Text
import Foreign.Marshal.Utils
import Foreign.Ptr
import GHC
import GHC.Driver.Backend
import GHC.Driver.Session
import GHC.IO.Buffer
import GHC.IO.BufferedIO
import qualified GHC.IO.Device as Device
import GHC.IO.Handle.Internals
import GHC.Wasm.Prim
import GHCi.UI
import System.Directory
import System.IO
import System.IO.Unsafe
import System.Timeout

data Terminal = Terminal
  { pendingInput :: MVar (BS.ByteString, Bool),
    inputAvailable :: MVar (),
    interpreterThread :: IORef (Maybe ThreadId)
  }

{-# NOINLINE terminal #-}
terminal :: Terminal
terminal = unsafePerformIO $
  Terminal <$> newMVar (BS.empty, False) <*> newEmptyMVar <*> newIORef Nothing

instance Device.RawIO Terminal where
  read dev ptr _ size = do
    result <- readInput dev ptr size
    case result of
      Just count -> pure count
      Nothing -> readMVar (inputAvailable dev) >> Device.read dev ptr 0 size

  readNonBlocking dev ptr _ size = do
    result <- readInput dev ptr size
    pure $ case result of
      Just 0 -> Nothing
      Just count -> Just count
      Nothing -> Just 0

  write _ _ _ _ = ioError $ userError "GHCi terminal input is read-only"
  writeNonBlocking _ _ _ _ = ioError $ userError "GHCi terminal input is read-only"

instance Device.IODevice Terminal where
  ready dev writing milliseconds
    | writing = pure False
    | milliseconds < 0 = readMVar (inputAvailable dev) >> pure True
    | milliseconds == 0 = not <$> isEmptyMVar (inputAvailable dev)
    | otherwise = isJust <$> timeout (milliseconds * 1000) (readMVar $ inputAvailable dev)

  close _ = pure ()
  getEcho _ = pure False
  setEcho _ _ = pure ()
  setRaw _ _ = pure ()
  devType _ = pure Device.Stream
  dup = pure
  dup2 source _ = pure source

instance BufferedIO Terminal where
  newBuffer _ = newByteBuffer 4096
  fillReadBuffer = readBuf
  fillReadBuffer0 = readBufNonBlocking
  flushWriteBuffer = writeBuf
  flushWriteBuffer0 = writeBufNonBlocking

readInput :: Terminal -> Ptr a -> Int -> IO (Maybe Int)
readInput dev ptr size =
  modifyMVar (pendingInput dev) $ \(bytes, eof) ->
    if BS.null bytes
      then pure ((bytes, eof), if eof || size == 0 then Just 0 else Nothing)
      else do
        let (chunk, rest) = BS.splitAt size bytes
        BS.useAsCStringLen chunk $ \(source, count) -> copyBytes ptr (castPtr source) count
        when (BS.null rest && not eof) $ void $ tryTakeMVar $ inputAvailable dev
        pure ((rest, eof), Just $ BS.length chunk)

terminalInput :: JSString -> IO ()
terminalInput input = do
  bytes <- evaluate (Text.encodeUtf8 $ Text.pack $ fromJSString input)
    `finally` freeJSVal (coerce input)
  unless (BS.null bytes) $
    modifyMVar_ (pendingInput terminal) $ \(pending, eof) -> do
      unless eof $ void $ tryPutMVar (inputAvailable terminal) ()
      pure (if eof then pending else pending <> bytes, eof)

terminalEOF :: IO ()
terminalEOF = modifyMVar_ (pendingInput terminal) $ \(pending, _) -> do
  void $ tryPutMVar (inputAvailable terminal) ()
  pure (pending, True)

interrupt :: IO ()
interrupt = do
  modifyMVar_ (pendingInput terminal) $ \(_, eof) -> do
    unless eof $ void $ tryTakeMVar $ inputAvailable terminal
    pure (BS.empty, eof)
  readIORef (interpreterThread terminal) >>= mapM_ (`throwTo` UserInterrupt)

myMain :: JSString -> IO ()
myMain jsLibdir = do
  libdir <- evaluate (fromJSString jsLibdir)
    `finally` freeJSVal (coerce jsLibdir)
  bracket_ startSession endSession $
    bracket installInput restoreInput $ \_ -> do
      setCurrentDirectory "/workspace"
      mapM_ (`hSetBuffering` NoBuffering) [stdin, stdout, stderr]
      mapM_ (`hSetEncoding` utf8) [stdin, stdout, stderr]
      putStrLn ghciWelcomeMsg
      runGhc (Just libdir) $ do
        original <- getSessionDynFlags
        let flags = foldl gopt_set
              original
                { ghcMode = CompManager,
                  backend = bytecodeBackend,
                  ghcLink = LinkInMemory,
                  verbosity = 1
                }
              [ Opt_ImplicitImportQualified,
                Opt_IgnoreOptimChanges,
                Opt_IgnoreHpcChanges,
                Opt_UseBytecodeRatherThanObjects,
                Opt_InsertBreakpoints,
                Opt_LocalGhciHistory,
                Opt_IgnoreDotGhci
              ]
        setSessionDynFlags flags
        initialized <- getSessionDynFlags
        interactiveUI defaultGhciSettings initialized [] Nothing
  where
    startSession = do
      tid <- myThreadId
      previous <- atomicModifyIORef' (interpreterThread terminal) $ \current ->
        (if isNothing current then Just tid else current, current)
      when (isJust previous) $ ioError $ userError "GHCi is already running"
      modifyMVar_ (pendingInput terminal) $ \_ -> do
        void $ tryTakeMVar $ inputAvailable terminal
        pure (BS.empty, False)

    endSession = do
      writeIORef (interpreterThread terminal) Nothing
      hFlush stdout
      hFlush stderr

    installInput = do
      handle <- mkFileHandleNoFinalizer terminal "<xterm>" ReadMode (Just utf8) noNewlineTranslation
      previous <- withHandle_ "playground input" handle $ \replacement ->
        withHandle "playground input" stdin $ \original -> pure (replacement, original)
      pure (handle, previous)

    restoreInput (handle, previous) = do
      withHandle "playground input" stdin $ \_ -> pure (previous, ())
      hClose handle

foreign export javascript "myMain"
  myMain :: JSString -> IO ()

foreign export javascript "terminalInput"
  terminalInput :: JSString -> IO ()

foreign export javascript "terminalEOF"
  terminalEOF :: IO ()

foreign export javascript "interrupt"
  interrupt :: IO ()
