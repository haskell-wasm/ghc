{-# LANGUAGE CPP #-}

-- | LLVM config cache
module GHC.Driver.LlvmConfigCache
  ( LlvmConfigCache
  , initLlvmConfigCache
#if !defined(wasm32_HOST_ARCH)
  , readLlvmConfigCache
#endif
  )
where

import GHC.Prelude
#if !defined(wasm32_HOST_ARCH)
import GHC.CmmToLlvm.Config

import System.IO.Unsafe
#endif

#if defined(wasm32_HOST_ARCH)
-- | LLVM isn't available on wasm32 hosts, but 'HscEnv' retains a cache field.
data LlvmConfigCache = LlvmConfigCache

initLlvmConfigCache :: FilePath -> IO LlvmConfigCache
initLlvmConfigCache _ = pure LlvmConfigCache
#else
-- | Cache LLVM configuration read from files in top_dir
--
-- See Note [LLVM configuration] in GHC.CmmToLlvm.Config
--
-- Currently implemented with unsafe lazy IO. But it could be implemented with
-- an IORef as the exposed interface is in IO.
data LlvmConfigCache = LlvmConfigCache LlvmConfig

initLlvmConfigCache :: FilePath -> IO LlvmConfigCache
initLlvmConfigCache top_dir = pure $ LlvmConfigCache (unsafePerformIO $ initLlvmConfig top_dir)

readLlvmConfigCache :: LlvmConfigCache -> IO LlvmConfig
readLlvmConfigCache (LlvmConfigCache !config) = pure config
#endif
