-- \section[Hooks]{Low level API hooks}

-- NB: this module is SOURCE-imported by DynFlags, and should primarily
--     refer to *types*, rather than *code*

{-# LANGUAGE CPP, RankNTypes, TypeFamilies #-}

module GHC.Driver.Hooks
   ( Hooks
   , HasHooks (..)
   , ContainsHooks (..)
   , emptyHooks
     -- the hooks:
   , DsForeignsHook
   , dsForeignsHook
   , tcForeignImportsHook
   , tcForeignExportsHook
   , hscFrontendHook
   , hscCompileCoreExprHook
   , ghcPrimIfaceHook
   , runPhaseHook
   , runMetaHook
   , linkHook
   , runRnSpliceHook
   , getValueSafelyHook
   , createIservProcessHook
#if !defined(wasm32_HOST_ARCH)
   , stgToCmmHook
   , cmmToRawCmmHook
#endif
   )
where

import GHC.Prelude

import GHC.Driver.Env
import GHC.Driver.DynFlags
import GHC.Driver.Pipeline.Phases

import GHC.Hs.Decls
import GHC.Hs.Binds
import GHC.Hs.Expr
import GHC.Hs.Extension

import GHC.Types.Name.Reader
import GHC.Types.Name
import GHC.Types.Id
import GHC.Types.SrcLoc
import GHC.Types.Basic
#if !defined(wasm32_HOST_ARCH)
import GHC.Types.CostCentre
import GHC.Types.IPE
#endif
import GHC.Types.Meta

#if !defined(wasm32_HOST_ARCH)
import GHC.Unit.Module
#endif
import GHC.Unit.Module.ModSummary
import GHC.Unit.Module.ModIface
import GHC.Unit.Home.PackageTable

import GHC.Core
#if !defined(wasm32_HOST_ARCH)
import GHC.Core.TyCon
#endif
import GHC.Core.Type

import GHC.Tc.Types
#if !defined(wasm32_HOST_ARCH)
import GHC.Stg.Syntax
import GHC.StgToCmm.CgUtils (CgStream)
import GHC.StgToCmm.Types (ModuleLFInfos)
import GHC.StgToCmm.Config
import GHC.Cmm
#endif

import GHCi.RemoteTypes

import GHC.Data.Bag

import qualified Data.Kind
import System.Process
import GHC.Linker.Types

{-
************************************************************************
*                                                                      *
\subsection{Hooks}
*                                                                      *
************************************************************************
-}

-- | Hooks can be used by GHC API clients to replace parts of
--   the compiler pipeline. If a hook is not installed, GHC
--   uses the default built-in behaviour

emptyHooks :: Hooks
emptyHooks = Hooks
  { dsForeignsHook         = Nothing
  , tcForeignImportsHook   = Nothing
  , tcForeignExportsHook   = Nothing
  , hscFrontendHook        = Nothing
  , hscCompileCoreExprHook = Nothing
  , ghcPrimIfaceHook       = Nothing
  , runPhaseHook           = Nothing
  , runMetaHook            = Nothing
  , linkHook               = Nothing
  , runRnSpliceHook        = Nothing
  , getValueSafelyHook     = Nothing
  , createIservProcessHook = Nothing
#if !defined(wasm32_HOST_ARCH)
  , stgToCmmHook           = Nothing
  , cmmToRawCmmHook        = Nothing
#endif
  }

{- Note [The Decoupling Abstract Data Hack]
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
The "Abstract Data" idea is due to Richard Eisenberg in
https://gitlab.haskell.org/ghc/ghc/-/merge_requests/1957, where the pattern is
described in more detail.

Here we use it as a temporary measure to break the dependency from the Parser on
the Desugarer until the parser is free of DynFlags. We introduced a nullary type
family @DsForeignsook@, whose single definition is in GHC.HsToCore.Types, where
we instantiate it to

   [LForeignDecl GhcTc] -> DsM (ForeignStubs, OrdList (Id, CoreExpr))

In doing so, the Hooks module (which is an hs-boot dependency of DynFlags) can
be decoupled from its use of the DsM definition in GHC.HsToCore.Types. Since
both DsM and the definition of @ForeignsHook@ live in the same module, there is
virtually no difference for plugin authors that want to write a foreign hook.

An awkward consequences is that the `type instance DsForeignsHook`, in
GHC.HsToCore.Types is an orphan instance.
-}

-- See Note [The Decoupling Abstract Data Hack]
type family DsForeignsHook :: Data.Kind.Type

data Hooks = Hooks
  { dsForeignsHook         :: !(Maybe DsForeignsHook)
  -- ^ Actual type:
  -- @Maybe ([LForeignDecl GhcTc] -> DsM (ForeignStubs, OrdList (Id, CoreExpr)))@
  , tcForeignImportsHook   :: !(Maybe ([LForeignDecl GhcRn]
                          -> TcM ([Id], [LForeignDecl GhcTc], Bag GlobalRdrElt)))
  , tcForeignExportsHook   :: !(Maybe ([LForeignDecl GhcRn]
            -> TcM (LHsBinds GhcTc, [LForeignDecl GhcTc], Bag GlobalRdrElt)))
  , hscFrontendHook        :: !(Maybe (ModSummary -> Hsc FrontendResult))
  , hscCompileCoreExprHook :: !(Maybe (HscEnv -> SrcSpan -> CoreExpr -> IO (ForeignHValue, [Linkable], PkgsLoaded)))
  , ghcPrimIfaceHook       :: !(Maybe ModIface)
  , runPhaseHook           :: !(Maybe PhaseHook)
  , runMetaHook            :: !(Maybe (MetaHook TcM))
  , linkHook               :: !(Maybe (GhcLink -> DynFlags -> Bool
                                         -> HomePackageTable -> IO SuccessFlag))
  , runRnSpliceHook        :: !(Maybe (HsUntypedSplice GhcRn -> RnM (HsUntypedSplice GhcRn)))
  , getValueSafelyHook     :: !(Maybe (HscEnv -> Name -> Type
                                         -> IO (Either Type (HValue, [Linkable], PkgsLoaded))))
  , createIservProcessHook :: !(Maybe (CreateProcess -> IO ProcessHandle))
#if !defined(wasm32_HOST_ARCH)
  , stgToCmmHook           :: !(Maybe (StgToCmmConfig -> InfoTableProvMap -> [TyCon] -> CollectedCCs
                                 -> [CgStgTopBinding] -> CgStream CmmGroup ModuleLFInfos))
  , cmmToRawCmmHook        :: !(forall a . Maybe (DynFlags -> Maybe Module -> CgStream CmmGroupSRTs a
                                 -> IO (CgStream RawCmmGroup a)))
#endif
  }

class HasHooks m where
    getHooks :: m Hooks

class ContainsHooks a where
    extractHooks :: a -> Hooks
