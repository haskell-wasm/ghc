module Playground (myMain, interrupt) where

import Control.Concurrent (ThreadId, myThreadId, threadDelay)
import Control.Exception (AsyncException (UserInterrupt), bracket, bracket_, evaluate, throwTo)
import Control.Monad (void)
import Control.Monad.IO.Class (liftIO)
import Data.Coerce (coerce)
import Data.IORef
import Data.Word (Word8)
import Foreign.Ptr (Ptr)
import GHC
import GHC.Driver.Session
import GHC.IO.Buffer (newByteBuffer)
import GHC.IO.BufferedIO
import GHC.IO.Device
import GHC.IO.Handle.Internals
  ( flushBuffer,
    mkFileHandleNoFinalizer,
    withAllHandles__,
    withHandle_,
  )
import GHC.Wasm.Prim
import GHCi.UI (defaultGhciSettings, ghciWelcomeMsg, interactiveUI)
import System.Directory (setCurrentDirectory)
import System.Environment (setEnv)
import System.IO
import System.IO.Unsafe (unsafePerformIO)

-- Run the ordinary GHCi command loop over the browser terminal. In
-- particular, commands, multiline input, context and loaded modules all
-- belong to the same GHCi session until the user enters :quit.
myMain :: JSString -> JSString -> IO ()
myMain jsLibdir jsWorkspace = do
  thread <- myThreadId
  bracket_
    (atomicWriteIORef sessionThread $ Just thread)
    (atomicWriteIORef sessionThread Nothing)
    (runSession jsLibdir jsWorkspace)

runSession :: JSString -> JSString -> IO ()
runSession jsLibdir jsWorkspace = do
  libdir <- takeJSString jsLibdir
  workspace <- takeJSString jsWorkspace
  installTerminal stdin ReadMode
  installTerminal stdout WriteMode
  installTerminal stderr WriteMode
  setCurrentDirectory workspace
  -- GHC's package loader must find the packaged C libraries directly,
  -- as well as the JavaScript dynamic linker knowing their search path.
  setEnv "LIBRARY_PATH" "/tmp/clib"
  defaultErrorHandler defaultFatalMessager defaultFlushOut $
    runGhc (Just libdir) $ do
      initialFlags <- getSessionDynFlags
      let flags =
            initialFlags
              { ghcMode = CompManager,
                backend = interpreterBackend,
                ghcLink = LinkInMemory,
                verbosity = 1
              }
              `gopt_set` Opt_ImplicitImportQualified
              `gopt_set` Opt_IgnoreOptimChanges
              `gopt_set` Opt_IgnoreHpcChanges
              `gopt_set` Opt_UseBytecodeRatherThanObjects
              `gopt_set` Opt_InsertBreakpoints
              `gopt_set` Opt_IgnoreDotGhci
              `gopt_unset` Opt_GhciHistory
      void $ setSessionDynFlags flags
      -- Initializing the package state fills in target platform constants.
      -- GHCi's home units must inherit these initialized flags.
      sessionFlags <- getSessionDynFlags
      liftIO $ putStrLn ghciWelcomeMsg
      interactiveUI defaultGhciSettings sessionFlags [] Nothing

-- JavaScript invokes this export from a separate Haskell thread. Deliver
-- the same exception as the native terminal's Ctrl+C; GHCi's existing
-- exception handler then returns to the prompt without losing the session.
interrupt :: IO ()
interrupt = readIORef sessionThread >>= mapM_ (`throwTo` UserInterrupt)

{-# NOINLINE sessionThread #-}
sessionThread :: IORef (Maybe ThreadId)
sessionThread = unsafePerformIO $ newIORef Nothing

takeJSString :: JSString -> IO String
takeJSString value = do
  result <- evaluate $ fromJSString value
  freeJSVal $ coerce value
  pure result

-- WASI preview 1 cannot suspend fd_read while waiting for browser input.
-- A Handle device lets safe JSFFI suspend just the Haskell thread instead.
-- The interpreted program shares these base Handles, so getLine and
-- putStr use the same terminal as GHCi, including output without a newline.
data Terminal = Terminal

installTerminal :: Handle -> IOMode -> IO ()
installTerminal handle mode = do
  replacement <-
    mkFileHandleNoFinalizer Terminal "<xterm>" mode (Just utf8) noNewlineTranslation
  -- hDuplicateTo requires both devices to have the same type; the original
  -- standard Handle has an FD device. Replace its state under the Handle
  -- lock instead. No finalizer is attached to the temporary replacement.
  withHandle_ "installTerminal" replacement $ \replacementState ->
    withAllHandles__ "installTerminal" handle $ \originalState -> do
      flushBuffer originalState
      pure replacementState
  hSetBuffering handle NoBuffering

instance IODevice Terminal where
  ready _ True _ = pure True
  ready _ False milliseconds = waitForInput milliseconds
  close _ = pure ()
  -- xterm handles line editing. Keeping this False selects GHCi's Handle
  -- input path instead of Haskeline's OS-specific terminal driver.
  isTerminal _ = pure False
  devType _ = pure Stream
  dup = pure
  dup2 source _ = pure source

waitForInput :: Int -> IO Bool
waitForInput milliseconds = do
  available <- jsReady
  if available || milliseconds == 0
    then pure available
    else do
      let delay = if milliseconds < 0 then 10 else min 10 milliseconds
      threadDelay $ delay * 1000
      waitForInput $ if milliseconds < 0 then milliseconds else milliseconds - delay

instance RawIO Terminal where
  read _ buffer _ count =
    bracket (jsRead count) freeJSVal $ \bytes -> jsCopyBytes bytes buffer
  readNonBlocking _ buffer _ count = do
    result <- jsReadNonBlocking buffer count
    pure $ if result < 0 then Nothing else Just result
  write _ buffer _ count = jsWrite buffer count
  writeNonBlocking _ buffer _ count = jsWrite buffer count >> pure count

instance BufferedIO Terminal where
  newBuffer _ = newByteBuffer 4096
  fillReadBuffer = readBuf
  fillReadBuffer0 = readBufNonBlocking
  flushWriteBuffer = writeBuf
  flushWriteBuffer0 = writeBufNonBlocking

-- Read methods return at most count bytes. An empty blocking read, or null
-- from a nonblocking read, denotes EOF. Do not pass the Haskell buffer to
-- the asynchronous JavaScript operation: an interrupt could otherwise let
-- its Promise write to a buffer whose Haskell thread has already unwound.
foreign import javascript safe
  "globalThis.playgroundTerminal.read($1)"
  jsRead :: Int -> IO JSVal

foreign import javascript unsafe
  "new Uint8Array(__exports.memory.buffer, $2, $1.length).set($1); return $1.length;"
  jsCopyBytes :: JSVal -> Ptr Word8 -> IO Int

foreign import javascript unsafe
  "const bytes = globalThis.playgroundTerminal.readNonBlocking($2); if (bytes === null) return -1; new Uint8Array(__exports.memory.buffer, $1, bytes.length).set(bytes); return bytes.length;"
  jsReadNonBlocking :: Ptr Word8 -> Int -> IO Int

foreign import javascript unsafe
  "globalThis.playgroundTerminal.ready()"
  jsReady :: IO Bool

-- xterm consumes output asynchronously, so copy the bytes before returning
-- ownership of the buffer to the Haskell runtime.
foreign import javascript unsafe
  "globalThis.playgroundTerminal.write(new Uint8Array(__exports.memory.buffer, $1, $2).slice())"
  jsWrite :: Ptr Word8 -> Int -> IO ()

foreign export javascript "myMain"
  myMain :: JSString -> JSString -> IO ()

foreign export javascript "interrupt"
  interrupt :: IO ()
